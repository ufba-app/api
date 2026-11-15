import { Secret } from '../../../application/shared/secret';
import { SiasbError, SiasbSession } from '../../../application/ports/siasb-source';
import { SiasbClient } from './siasb-client';

const PASSWORD = 'senha-canario-123';
const COOKIE_VALUE = 'cookie-canario-456';
const REG_COOKIE = '123456789_idcurso';

function res(status: number, body?: unknown, setCookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function fake(...responses: Array<Response | Error>) {
  const queue = [...responses];
  return jest.fn(async (_url: unknown, _init?: unknown) => {
    const next = queue.shift();
    if (!next) throw new Error('sem resposta programada');
    if (next instanceof Error) throw next;
    return next;
  });
}

const client = (f: jest.Mock) => new SiasbClient({ fetch: f as unknown as typeof fetch });
const session = () =>
  new SiasbSession({ 'OWEnsino.Modern.Auth': COOKIE_VALUE, [REG_COOKIE]: '1' }, null, false);

describe('SiasbClient.login', () => {
  it('manda o corpo certo, junta os cookies e usa o maior Expires', async () => {
    const f = fake(
      res(200,{ username: '123456789' }, [
        `OWEnsino.Modern.Auth=${COOKIE_VALUE}; expires=Tue, 15 Dec 2026 04:09:00 GMT; path=/; secure; httponly; samesite=lax`,
        'IdCursoDefault=1; expires=Mon, 14 Dec 2026 04:09:00 GMT; path=/',
        `${REG_COOKIE}=1; expires=Tue, 15 Dec 2026 04:09:01 GMT; path=/`,
      ]),
    );
    const out = await client(f).login('123456789', Secret.of(PASSWORD), 1);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.siasb.ufba.br/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      username: '123456789',
      password: PASSWORD,
      selectedCourseId: 1,
      rememberMe: true,
    });
    expect(out.session.cookies['OWEnsino.Modern.Auth']).toBe(COOKIE_VALUE);
    expect(Object.keys(out.session.cookies)).toHaveLength(3);
    expect(out.session.expiresAt?.toISOString()).toBe('2026-12-15T04:09:01.000Z');
    expect(out.username).toBe('123456789');
  });

  it('sem username no corpo, consulta auth/session', async () => {
    const f = fake(
      res(200, {}, ['A=1; expires=Tue, 15 Dec 2026 04:09:00 GMT']),
      res(200, { username: '987' }),
    );
    const out = await client(f).login('987', Secret.of(PASSWORD), 1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.username).toBe('987');
  });

  it.each([
    [409, { code: 'password_migration_required', username: 'x' }, 'PASSWORD_MIGRATION_REQUIRED'],
    [401, 'The user name or password is invalid.', 'CREDENTIAL_REJECTED'],
    [500, undefined, 'UNAVAILABLE'],
    [503, undefined, 'UNAVAILABLE'],
  ])('status %s vira %s sem nova tentativa', async (status, body, code) => {
    const f = fake(res(status, body));
    await expect(client(f).login('1', Secret.of(PASSWORD), 1)).rejects.toMatchObject({ code });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falha de rede vira UNAVAILABLE sem nova tentativa', async () => {
    const f = fake(new Error('boom'));
    await expect(client(f).login('1', Secret.of(PASSWORD), 1)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('SiasbClient.get', () => {
  it('401 vira REAUTH_NEEDED', async () => {
    const f = fake(res(401));
    await expect(client(f).get(session(), '/auth/session')).rejects.toMatchObject({
      code: 'REAUTH_NEEDED',
    });
  });

  it('envia o header Cookie e atualiza o jar com Set-Cookie (dirty)', async () => {
    const f = fake(
      res(200, { ok: 1 }, ['OWEnsino.Modern.Auth=novo; expires=Tue, 15 Jan 2027 04:09:00 GMT']),
    );
    const s = session();
    const body = await client(f).get(s, '/auth/session');
    expect(body).toEqual({ ok: 1 });
    const init = f.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toContain(`OWEnsino.Modern.Auth=${COOKIE_VALUE}`);
    expect(headers.Accept).toBe('application/json');
    expect(init.cache).toBe('no-store');
    expect(s.cookies['OWEnsino.Modern.Auth']).toBe('novo');
    expect(s.dirty).toBe(true);
    expect(s.expiresAt?.toISOString()).toBe('2027-01-15T04:09:00.000Z');
  });

  it('sem Set-Cookie não suja a sessão', async () => {
    const s = session();
    await client(fake(res(200, []))).get(s, '/student/new-attendance/disciplines');
    expect(s.dirty).toBe(false);
  });

  it('repete até 2 vezes em 5xx e em rede, e depois falha com UNAVAILABLE', async () => {
    const f = fake(res(502), new Error('x'), res(200, { ok: true }));
    await expect(client(f).get(session(), '/auth/session')).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(3);
    const g = fake(res(500), res(500), res(500), res(200, {}));
    await expect(client(g).get(session(), '/auth/session')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(g).toHaveBeenCalledTimes(3);
  });

  it('corpo que não é JSON vira UNEXPECTED_FORMAT', async () => {
    const f = fake(new Response('<html>', { status: 200 }));
    await expect(client(f).get(session(), '/auth/session')).rejects.toMatchObject({
      code: 'UNEXPECTED_FORMAT',
    });
  });

  it.each([
    '/auth/session',
    '/student/new-attendance/disciplines',
    '/student/attendances?status=1',
    '/student/attendances?status=2',
    '/student/attendances?status=3',
    '/student/schedule/sessions?startAt=2026-11-01T00:00&endAt=2026-12-01T00:00',
    '/student/options?kind=procedures&attendanceId=42',
    '/student/options?kind=ambulatoryLocations',
    '/student/options?kind=professors',
    '/student/options?kind=patientGroups',
  ])('rota permitida: %s', async (path) => {
    const f = fake(res(200, []));
    await client(f).get(session(), path);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/student/attendances?status=4',
    '/student/attendances',
    '/student/attendances?status=1&status=4',
    '/student/attendances?status=1&x=2',
    '/student/unassigned-attendances',
    '/student/attendances/1/anamnesis',
    '/student/attendances/1',
    '/student/dashboard',
    '/student/options?kind=materials',
    '/student/options?kind=procedures',
    '/student/patient-documents/1/content',
    '/auth/logout',
    '/auth/session/../password',
    '/auth/session#x',
    'https://evil.example/auth/session',
    '//evil.example/auth/session',
    '/professor/patients/1/medical-record',
  ])('rota proibida sem chamar o fetch: %s', async (path) => {
    const f = fake(res(200, []));
    await expect(client(f).get(session(), path)).rejects.toMatchObject({
      code: 'FORBIDDEN_ROUTE',
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('SiasbClient.countUnassigned', () => {
  it('devolve só a contagem', async () => {
    const f = fake(res(200, [{ patientName: 'Fulano', medicalRecordCode: '9' }, { patientName: 'B' }]));
    await expect(client(f).countUnassigned(session())).resolves.toBe(2);
  });
  it('formato inesperado', async () => {
    await expect(client(fake(res(200, {}))).countUnassigned(session())).rejects.toMatchObject({
      code: 'UNEXPECTED_FORMAT',
    });
  });
});

describe('SiasbClient.courseOptions', () => {
  it('mapeia a lista de cursos', async () => {
    const f = fake(
      res(200, [
        { courseId: 1, courseDescription: 'Odontologia', courseAbbreviation: 'ODO', isDefaultSelection: true },
      ]),
    );
    const out = await client(f).courseOptions('123456789');
    expect(out).toEqual([{ id: 1, name: 'Odontologia', abbreviation: 'ODO', isDefault: true }]);
    expect(f.mock.calls[0][0]).toBe(
      'https://api.siasb.ufba.br/api/v1/auth/course-options?username=123456789',
    );
  });
  it('lista vazia', async () => {
    await expect(client(fake(res(200, []))).courseOptions('1')).resolves.toEqual([]);
  });
  it('formato inesperado', async () => {
    await expect(client(fake(res(200, { a: 1 }))).courseOptions('1')).rejects.toMatchObject({
      code: 'UNEXPECTED_FORMAT',
    });
  });
});

describe('canário', () => {
  it('senha, valor e nome de cookie não vazam em erros', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => client(fake(res(401, `bad ${PASSWORD}`))).login('123456789', Secret.of(PASSWORD), 1),
      () =>
        client(fake(new Error(`falhou ${PASSWORD} ${COOKIE_VALUE} ${REG_COOKIE}`))).login(
          '123456789',
          Secret.of(PASSWORD),
          1,
        ),
      () =>
        client(fake(res(409, { code: 'password_migration_required' }))).login(
          '123456789',
          Secret.of(PASSWORD),
          1,
        ),
      () => client(fake(res(401))).get(session(), '/auth/session'),
      () => client(fake(res(500), res(500), res(500))).get(session(), '/auth/session'),
      () =>
        client(
          fake(new Error(`${COOKIE_VALUE} ${REG_COOKIE}`), new Error('a'), new Error('b')),
        ).get(session(), '/auth/session'),
      () => client(fake()).get(session(), '/student/attendances?status=4'),
      () =>
        client(fake(new Response(COOKIE_VALUE, { status: 200 }))).get(session(), '/auth/session'),
    ];
    for (const run of cases) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SiasbError);
      const dump = `${(err as Error).message} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
      for (const secret of [PASSWORD, COOKIE_VALUE, REG_COOKIE, '123456789_', 'OWEnsino']) {
        expect(dump).not.toContain(secret);
      }
    }
  });

  it('a sessão impressa ou serializada não mostra cookies', () => {
    const s = session();
    const dump = `${JSON.stringify(s)} ${String(s)}`;
    expect(dump).not.toContain(COOKIE_VALUE);
    expect(dump).not.toContain(REG_COOKIE);
  });
});
