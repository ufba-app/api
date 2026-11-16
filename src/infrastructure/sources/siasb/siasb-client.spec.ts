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

const client = (f: jest.Mock) => new SiasbClient({ fetch: f as unknown as typeof fetch, retryDelayMs: 0 });
const session = () =>
  new SiasbSession({ 'OWEnsino.Modern.Auth': COOKIE_VALUE, [REG_COOKIE]: '1' }, null, false);

describe('SiasbClient.login', () => {
  it('manda o corpo certo, junta os cookies e usa o maior Expires', async () => {
    const f = fake(
      res(200, { username: 'outra-pessoa' }, [
        `OWEnsino.Modern.Auth=${COOKIE_VALUE}; expires=Tue, 15 Dec 2026 04:09:00 GMT; path=/; secure; httponly; samesite=lax`,
        'IdCursoDefault=1; expires=Mon, 14 Dec 2026 04:09:00 GMT; path=/',
        `${REG_COOKIE}=1; expires=Tue, 15 Dec 2026 04:09:01 GMT; path=/`,
      ]),
      res(200, { username: '123456789' }),
    );
    const out = await client(f).login('123456789', Secret.of(PASSWORD), 1);
    expect(f).toHaveBeenCalledTimes(2);
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

  it('o username vem de auth/session, mesmo que o corpo do login traga outro', async () => {
    const f = fake(
      res(200, { username: '111' }, ['A=1; expires=Tue, 15 Dec 2026 04:09:00 GMT']),
      res(200, { username: '987' }),
    );
    const out = await client(f).login('987', Secret.of(PASSWORD), 1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.username).toBe('987');
  });

  it('auth/session sem username: UNEXPECTED_FORMAT, mesmo que o corpo do login traga um', async () => {
    const f = fake(res(200, { username: '1' }, ['A=1; path=/']), res(200, {}));
    await expect(client(f).login('1', Secret.of(PASSWORD), 1)).rejects.toMatchObject({ code: 'UNEXPECTED_FORMAT' });
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

  it('409 com código desconhecido vira UNEXPECTED_FORMAT, não migração de senha', async () => {
    const f = fake(res(409, { code: 'outra_coisa' }));
    await expect(client(f).login('1', Secret.of(PASSWORD), 1)).rejects.toMatchObject({
      code: 'UNEXPECTED_FORMAT',
    });
  });

  it('429 e redirect (3xx) viram UNAVAILABLE sem nova tentativa', async () => {
    for (const status of [429, 307, 308]) {
      const f = fake(res(status));
      await expect(client(f).login('1', Secret.of(PASSWORD), 1)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('nunca segue redirect (redirect: error), no login e no GET', async () => {
    const f = fake(res(200, {}, ['A=1; path=/']), res(200, { username: '1' }), res(200, {}));
    const c = client(f);
    await c.login('1', Secret.of(PASSWORD), 1);
    await c.get(session(), '/auth/session');
    for (const call of f.mock.calls) expect((call[1] as RequestInit).redirect).toBe('error');
  });

  it('login que falha não deixa sessão nem cookie para trás', async () => {
    const c = client(fake(res(401, undefined, ['A=1; path=/'])));
    const out = await c.login('1', Secret.of(PASSWORD), 1).then(
      () => 'ok',
      (e: unknown) => e,
    );
    expect(out).toBeInstanceOf(SiasbError);
    expect(JSON.stringify(out)).not.toContain('A=1');
  });

  it('Max-Age vence o Expires', async () => {
    const f = fake(res(200, { username: '1' }, ['A=1; Max-Age=3600; expires=Tue, 15 Dec 2030 04:09:00 GMT']), res(200, { username: '1' }));
    const before = Date.now();
    const out = await client(f).login('1', Secret.of(PASSWORD), 1);
    const exp = out.session.expiresAt?.getTime() ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000 + 1000);
  });

  it('cookie apagado (valor vazio ou Expires no passado) não vira cookie nem alimenta expiresAt', async () => {
    const f = fake(
      res(200, { username: '1' }, [
        'A=1; expires=Tue, 15 Dec 2026 04:09:00 GMT',
        'B=; expires=Tue, 15 Dec 2040 04:09:00 GMT',
        'C=3; expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ]),
      res(200, { username: '1' }),
    );
    const out = await client(f).login('1', Secret.of(PASSWORD), 1);
    expect(Object.keys(out.session.cookies)).toEqual(['A']);
    expect(out.session.expiresAt?.toISOString()).toBe('2026-12-15T04:09:00.000Z');
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

  it('vários cookies no header Cookie, e cookie apagado sai do jar', async () => {
    const f = fake(res(200, {}, ['OWEnsino.Modern.Auth=; path=/']));
    const s = session();
    await client(f).get(s, '/auth/session');
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Cookie).toBe(`OWEnsino.Modern.Auth=${COOKIE_VALUE}; ${REG_COOKIE}=1`);
    expect(s.cookies['OWEnsino.Modern.Auth']).toBeUndefined();
    expect(s.dirty).toBe(true);
  });

  it('403 vira REAUTH_NEEDED; 429 e redirect viram UNAVAILABLE, sem repetir', async () => {
    const a = fake(res(403));
    await expect(client(a).get(session(), '/auth/session')).rejects.toMatchObject({ code: 'REAUTH_NEEDED' });
    for (const status of [429, 307]) {
      const f = fake(res(status));
      await expect(client(f).get(session(), '/auth/session')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('cancela o corpo de respostas descartadas (5xx repetido)', async () => {
    let cancelled = 0;
    const withBody = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('x'));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 500 },
      );
    const f = fake(withBody(), withBody(), withBody());
    await expect(client(f).get(session(), '/auth/session')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(3);
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
    '/auth/session/%2e%2e/password',
    '/auth/session\n',
    '/student/attendances?status=4\n',
    '/student/attendances?status=%34',
    '/student/attendances?STATUS=4',
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

describe('SiasbClient, métodos de leitura', () => {
  const lastUrl = (f: jest.Mock) => f.mock.calls[f.mock.calls.length - 1][0] as string;
  const API = 'https://api.siasb.ufba.br/api/v1';

  it('unassignedCount devolve só contagem por disciplina', async () => {
    const f = fake(
      res(200, [
        { disciplineId: 11, patientName: 'Fulano', medicalRecordCode: '9' },
        { disciplineId: 11, patientName: 'B' },
        { disciplineId: 12 },
      ]),
    );
    const out = await client(f).unassignedCount(session());
    expect(out).toEqual({ '11': 2, '12': 1 });
    expect(JSON.stringify(out)).not.toContain('Fulano');
    expect(lastUrl(f)).toBe(`${API}/student/unassigned-attendances`);
  });
  it('unassignedCount com formato inesperado', async () => {
    await expect(client(fake(res(200, {}))).unassignedCount(session())).rejects.toMatchObject({
      code: 'UNEXPECTED_FORMAT',
    });
  });

  it('disciplines, attendances e sessions chamam a rota certa e mapeiam', async () => {
    const f = fake(
      res(200, [{ disciplineId: 1, disciplineName: 'D' }]),
      res(200, [{ id: 5, disciplineId: 1, patientName: 'Ana Maria', treatmentType: 2, status: 3 }]),
      res(200, [{ id: 5, disciplineId: 1, patientName: 'Ana Maria', treatmentType: 2, status: 2 }]),
      res(200, []),
    );
    const c = client(f);
    await expect(c.disciplines(session())).resolves.toEqual([{ id: '1', name: 'D' }]);
    expect(lastUrl(f)).toBe(`${API}/student/new-attendance/disciplines`);
    const act = await c.attendances(session(), 'active');
    expect(lastUrl(f)).toBe(`${API}/student/attendances?status=1`);
    expect(act[0].concluded).toBe(true);
    await c.attendances(session(), 'inactive');
    expect(lastUrl(f)).toBe(`${API}/student/attendances?status=2`);
    await c.sessions(session(), new Date('2026-11-27T11:00:00Z'), new Date('2026-12-27T02:59:00Z'));
    expect(lastUrl(f)).toBe(
      `${API}/student/schedule/sessions?startAt=2026-11-27T08:00&endAt=2026-12-26T23:59`,
    );
  });

  it('procedures usa o attendanceId e devolve o catálogo inteiro (a busca é do leitor)', async () => {
    const list = [
      { id: 1, name: '81000030 - Consulta Odontológica' },
      { id: 2, name: '82000050 - Raspagem' },
    ];
    const f = fake(res(200, list));
    await expect(client(f).procedures(session(), '42')).resolves.toEqual([
      { id: '1', name: '81000030 - Consulta Odontológica' },
      { id: '2', name: '82000050 - Raspagem' },
    ]);
    expect(lastUrl(f)).toBe(`${API}/student/options?kind=procedures&attendanceId=42`);
  });

  it('attendanceId fora do padrão é FORBIDDEN_ROUTE', async () => {
    const f = fake();
    await expect(client(f).procedures(session(), '1&x=2')).rejects.toMatchObject({
      code: 'FORBIDDEN_ROUTE',
    });
    expect(f).not.toHaveBeenCalled();
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

describe('SiasbClient, escrita', () => {
  const API = 'https://api.siasb.ufba.br/api/v1';
  const REJECT_MSG = 'O SIASB recusou a operação.';
  const UNKNOWN_MSG = 'O SIASB não confirmou a operação.';
  const call = (f: jest.Mock, i = 0) => {
    const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
    return { url, init, body: init.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown) };
  };
  const sched = {
    attendanceId: '12',
    professorId: '301',
    locationId: '7',
    groupId: '4',
    startAt: new Date('2026-11-27T11:00:00Z'),
    endAt: new Date('2026-11-27T13:30:00Z'),
    count: 3,
    description: 'Retorno sintético',
  };

  it('scheduleSessions: POST no caminho certo com o corpo exato (horário da Bahia, ids numéricos)', async () => {
    const f = fake(res(200, { id: 7 }));
    const out = await client(f).scheduleSessions(session(), sched);
    expect(out).toEqual({ ok: true, createdId: '7' });
    const { url, init, body } = call(f);
    expect(url).toBe(`${API}/student/schedule/sessions`);
    expect(init.method).toBe('POST');
    expect(body).toEqual({
      sessionId: null,
      attendanceId: 12,
      professorId: 301,
      ambulatoryLocationId: 7,
      patientGroupId: 4,
      startAt: '2026-11-27T08:00:00',
      endAt: '2026-11-27T10:30:00',
      sessionCount: 3,
      description: 'Retorno sintético',
      reason: '',
      requestsRescheduling: false,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Cookie).toContain(`OWEnsino.Modern.Auth=${COOKIE_VALUE}`);
    expect(init.redirect).toBe('error');
  });

  it('unscheduleSession: disposition sempre com absence false', async () => {
    const f = fake(res(204));
    const out = await client(f).unscheduleSession(session(), '55', 'Paciente desistiu');
    expect(out).toEqual({ ok: true, createdId: null });
    const { url, init, body } = call(f);
    expect(url).toBe(`${API}/student/schedule/sessions/55/disposition`);
    expect(init.method).toBe('POST');
    expect(body).toEqual({ reason: 'Paciente desistiu', absence: false });
  });

  it('addProcedure: POST com o corpo exato', async () => {
    const f = fake(res(201, { procedureId: 90 }));
    const out = await client(f).addProcedure(session(), '12', {
      serviceId: 2,
      teeth: '11,12',
      faces: 'V',
      observation: 'obs sintética',
    });
    expect(out).toEqual({ ok: true, createdId: '90' });
    const { url, init, body } = call(f);
    expect(url).toBe(`${API}/student/attendances/12/procedures`);
    expect(init.method).toBe('POST');
    expect(body).toEqual({ serviceId: 2, teeth: '11,12', faces: 'V', observation: 'obs sintética' });
  });

  it('removeProcedure: DELETE sem corpo', async () => {
    const f = fake(res(200));
    const out = await client(f).removeProcedure(session(), '12', '90');
    expect(out).toEqual({ ok: true, createdId: null });
    const { url, init } = call(f);
    expect(url).toBe(`${API}/student/attendances/12/procedures/90`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it.each([
    ['POST', '/student/attendances/12/procedures/12/realize'],
    ['POST', '/student/attendances/12/procedures/12'],
    ['DELETE', '/student/schedule/sessions/1'],
    ['DELETE', '/student/attendances/12/procedures'],
    ['DELETE', '/student/attendances/12/procedures/12/realize'],
    ['POST', '/student/attendances/1a/procedures'],
    ['POST', '/student/attendances//procedures'],
    ['POST', '/student/attendances/../procedures'],
    ['DELETE', '/student/attendances/12/procedures/1a'],
    ['DELETE', '/student/attendances/12/procedures/..'],
    ['POST', '/student/schedule/sessions//disposition'],
    ['POST', '/student/schedule/sessions/1/disposition/'],
    ['POST', '/student/schedule/sessions?x=1'],
    ['PUT', '/student/schedule/sessions'],
    ['GET', '/student/schedule/sessions'],
    ['POST', '/auth/logout'],
    ['POST', '//evil.example/student/schedule/sessions'],
  ])('escrita proibida sem chamar o fetch: %s %s', async (method, path) => {
    const f = fake(res(200, {}));
    const c = client(f) as unknown as { write: (s: SiasbSession, m: string, p: string, b?: unknown) => Promise<unknown> };
    await expect(c.write(session(), method, path, {})).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    expect(f).not.toHaveBeenCalled();
  });

  it('ids malformados nos métodos públicos são FORBIDDEN_ROUTE sem rede', async () => {
    const f = fake(res(200, {}));
    const c = client(f);
    const proc = { serviceId: 1, teeth: '', faces: '', observation: '' };
    await expect(c.addProcedure(session(), '12/procedures/1/realize', proc)).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    await expect(c.removeProcedure(session(), '12', '1/realize')).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    await expect(c.removeProcedure(session(), '1a', '1')).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    await expect(c.unscheduleSession(session(), '1/../2', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    await expect(c.unscheduleSession(session(), '', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    await expect(c.scheduleSessions(session(), { ...sched, attendanceId: '12a' })).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    expect(f).not.toHaveBeenCalled();
  });

  it('timeout, queda de rede e 500 viram WRITE_UNKNOWN com UMA chamada (sem retry)', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    for (const next of [timeout, new Error('ECONNRESET'), res(500, { message: 'Fulano Sintetico' }), res(503), res(307)]) {
      const f = fake(next, res(200, {}));
      const err = await client(f).scheduleSessions(session(), sched).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: 'WRITE_UNKNOWN', message: UNKNOWN_MSG });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('400 vira WRITE_REJECTED com a mensagem fixa e o corpo nunca aparece', async () => {
    const f = fake(res(400, { message: 'Paciente Fulano Sintetico não pode', title: 'Fulano Sintetico' }));
    const err = await client(f).addProcedure(session(), '12', { serviceId: 1, teeth: '', faces: '', observation: '' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SiasbError);
    expect(err).toMatchObject({ code: 'WRITE_REJECTED', message: REJECT_MSG });
    const dump = `${(err as Error).message} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
    expect(dump).not.toContain('Fulano');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('as duas mensagens conhecidas da grade passam, em texto puro ou em JSON, só se exatas', async () => {
    const known = [
      'Você não possui aula desta disciplina neste dia e horário.',
      'O horário final ultrapassa o horário de aula da disciplina.',
    ];
    for (const m of known) {
      for (const r of [res(400, { message: m }), res(422, m), new Response(m, { status: 400 })]) {
        await expect(client(fake(r)).scheduleSessions(session(), sched)).rejects.toMatchObject({
          code: 'WRITE_REJECTED',
          message: m,
        });
      }
    }
    await expect(
      client(fake(res(400, { message: `${known[0]} Fulano Sintetico` }))).scheduleSessions(session(), sched),
    ).rejects.toMatchObject({ code: 'WRITE_REJECTED', message: REJECT_MSG });
  });

  it('401 e 403 viram REAUTH_NEEDED', async () => {
    for (const status of [401, 403]) {
      const f = fake(res(status));
      await expect(client(f).unscheduleSession(session(), '1', 'x')).rejects.toMatchObject({ code: 'REAUTH_NEEDED' });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    [{ id: 7 }, '7'],
    [{ data: { id: '9' } }, '9'],
    [{ procedureId: 31 }, '31'],
    [12, '12'],
    [{}, null],
    [{ id: 'abc' }, null],
    [{ id: 1.5 }, null],
    [{ id: { x: 1 } }, null],
    ['texto', null],
  ])('createdId de %j é %j', async (body, expected) => {
    const out = await client(fake(res(200, body))).scheduleSessions(session(), sched);
    expect(out).toEqual({ ok: true, createdId: expected });
  });

  it('corpo de 2xx que não é JSON vira createdId null', async () => {
    const out = await client(fake(new Response('<html>', { status: 200 }))).scheduleSessions(session(), sched);
    expect(out).toEqual({ ok: true, createdId: null });
  });

  it('o jar renovado por uma resposta de escrita marca session.dirty', async () => {
    const s = session();
    const f = fake(res(200, { id: 1 }, ['OWEnsino.Modern.Auth=novo; expires=Tue, 15 Jan 2027 04:09:00 GMT']));
    await client(f).scheduleSessions(s, sched);
    expect(s.cookies['OWEnsino.Modern.Auth']).toBe('novo');
    expect(s.dirty).toBe(true);
    const s2 = session();
    await client(fake(res(200, {}))).removeProcedure(s2, '1', '2');
    expect(s2.dirty).toBe(false);
  });

  it('schedulingOptions lê as três listas com attendanceId e mapeia', async () => {
    const f = fake(
      res(200, [{ id: 301, name: 'Profa. Exemplar Alfa', preferred: true }]),
      res(200, [{ id: 7, name: 'Clínica 1' }]),
      res(200, [{ id: 4, name: 'Grupo A', preferred: false }]),
    );
    const out = await client(f).schedulingOptions(session(), '12');
    expect(out).toEqual({
      professors: [{ id: '301', name: 'Profa. Exemplar Alfa', preferred: true }],
      locations: [{ id: '7', name: 'Clínica 1', preferred: false }],
      groups: [{ id: '4', name: 'Grupo A', preferred: false }],
    });
    const urls = f.mock.calls.map((c) => c[0] as string).sort();
    expect(urls).toEqual(
      [
        `${API}/student/options?kind=professors&attendanceId=12`,
        `${API}/student/options?kind=ambulatoryLocations&attendanceId=12`,
        `${API}/student/options?kind=patientGroups&attendanceId=12`,
      ].sort(),
    );
  });

  it('schedulingOptions com formato inesperado ou id ruim', async () => {
    await expect(
      client(fake(res(200, {}), res(200, []), res(200, []))).schedulingOptions(session(), '12'),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_FORMAT' });
    const f = fake();
    await expect(client(f).schedulingOptions(session(), '1&x=2')).rejects.toMatchObject({ code: 'FORBIDDEN_ROUTE' });
    expect(f).not.toHaveBeenCalled();
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
