import { Secret } from '../../../application/shared/secret';
import { MoodleAttachmentReader } from './moodle-attachment-reader';
import { MoodleClient, MoodleError } from './moodle-client';
import { MoodleGateway } from './moodle.gateway';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';

const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'moodle.test:aluno',
  siteUrl: 'https://moodle.test/',
  credentials: { kind: 'token', token: Secret.of('SEGREDO123') },
};

const json = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));

/** fetch falso: responde por wsfunction e registra as chamadas. */
function fakeMoodle(overrides: Record<string, unknown> = {}) {
  const calls: URLSearchParams[] = [];
  const responses: Record<string, unknown> = {
    core_webservice_get_site_info: { userid: 7 },
    core_enrol_get_users_courses: [
      { id: 10, fullname: 'Cálculo A', shortname: 'MAT001' },
      { id: 11, fullname: 'Física B' },
    ],
    core_course_get_contents: [
      {
        id: 1,
        name: 'Semana 1',
        modules: [
          {
            id: 100,
            name: 'Slides',
            modname: 'resource',
            contents: [
              {
                filename: 'aula1.pdf',
                filepath: '/',
                filesize: 2048,
                mimetype: 'application/pdf',
                fileurl: 'https://moodle.test/webservice/pluginfile.php/1/aula1.pdf?forcedownload=1',
              },
            ],
          },
          { id: 101, name: 'Tarefa 1', modname: 'assign' },
          { id: 102, name: 'Prova 1', modname: 'quiz' },
          { id: 103, name: 'Oculto', modname: 'resource', visible: 0 },
        ],
      },
    ],
    mod_assign_get_assignments: {
      courses: [
        {
          id: 10,
          assignments: [
            {
              id: 5,
              name: 'Lista 1',
              duedate: 1800000000,
              introattachments: [
                {
                  filename: 'lista.pdf',
                  fileurl: 'https://moodle.test/webservice/pluginfile.php/2/lista.pdf?token=VAZOU',
                },
              ],
            },
          ],
        },
      ],
    },
    mod_forum_get_forums_by_courses: [
      { id: 1, name: 'Avisos', type: 'news' },
      { id: 2, name: 'Dúvidas', type: 'general' },
    ],
    mod_forum_get_forum_discussions: { discussions: [{ id: 50, name: 'Bem-vindos', created: 1700000000 }] },
    gradereport_user_get_grade_items: {
      usergrades: [
        {
          gradeitems: [
            { id: 1, itemname: 'P1', graderaw: 8.5, grademax: 10, weightraw: 0.5 },
            { id: 2, itemname: null, graderaw: 8.5 },
          ],
        },
      ],
    },
    core_calendar_get_calendar_upcoming_view: {
      events: [{ id: 9, name: 'Lista 1 vence', timestart: 1800000000, course: { id: 10 } }],
    },
    ...overrides,
  };
  const fetchFn = ((_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    calls.push(body);
    return json(responses[body.get('wsfunction') as string]);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('MoodleGateway', () => {
  it('declara fonte MOODLE com token guardado', () => {
    const g = new MoodleGateway();
    expect(g.provider).toBe('MOODLE');
    expect(g.auth).toBe('token-guardado');
  });

  it('mapeia cursos, itens, anexos, notas e eventos', async () => {
    const { fetchFn, calls } = fakeMoodle();
    const gw = new MoodleGateway(new MoodleClient(fetchFn));
    const r = await gw.fetch(ctx, { kind: 'tudo' });

    expect(r.courseSpaces!.map((c) => c.name)).toEqual(['Cálculo A', 'Física B']);
    const c10 = r.items!.filter((i) => i.courseExternalId === '10');
    const kinds = c10.map((i) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['MATERIAL', 'ASSESSMENT', 'ASSIGNMENT', 'ANNOUNCEMENT', 'FORUM_TOPIC']),
    );
    expect(c10.find((i) => i.title === 'Oculto')).toBeUndefined();

    const material = c10.find((i) => i.title === 'Slides')!;
    expect(material.attachments![0]).toMatchObject({
      name: 'aula1.pdf',
      sizeBytes: 2048,
      mimeType: 'application/pdf',
    });

    const assign = c10.find((i) => i.kind === 'ASSIGNMENT')!;
    expect(assign.dueAt).toEqual(new Date(1800000000 * 1000));
    // token vazado pela fonte é removido do sourceUrl
    expect(assign.attachments![0].sourceUrl).not.toContain('token=');

    expect(r.grades).toHaveLength(2); // 1 nota por curso; item sem nome descartado
    expect(r.grades![0]).toMatchObject({ label: 'P1', score: 8.5, maxScore: 10 });
    expect(r.events![0].title).toBe('Lista 1 vence');

    expect(calls[0].get('wstoken')).toBe('SEGREDO123');
    expect(calls[0].get('moodlewsrestformat')).toBe('json');
  });

  it('escopo curso só busca o curso pedido e não traz eventos', async () => {
    const { fetchFn } = fakeMoodle();
    const r = await new MoodleGateway(new MoodleClient(fetchFn)).fetch(ctx, {
      kind: 'curso',
      courseExternalId: '11',
    });
    expect(r.courseSpaces!.map((c) => c.externalId)).toEqual(['11']);
    expect(r.events).toEqual([]);
  });

  it('escopo item filtra pelo externalId', async () => {
    const { fetchFn } = fakeMoodle();
    const r = await new MoodleGateway(new MoodleClient(fetchFn)).fetch(ctx, {
      kind: 'item',
      courseExternalId: '10',
      itemExternalId: 'assign5',
    });
    expect(r.items!.map((i) => i.externalId)).toEqual(['assign5']);
    expect(r.grades).toEqual([]);
  });

  it('504 nas notas de um curso não derruba a sincronização: o curso vira parcial com aviso', async () => {
    const calls: URLSearchParams[] = [];
    const base = fakeMoodle();
    const fetchFn = ((url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      calls.push(body);
      if (body.get('wsfunction') === 'gradereport_user_get_grade_items' && body.get('courseid') === '10') {
        return Promise.resolve(new Response('Gateway Timeout', { status: 504 }));
      }
      return base.fetchFn(url, init);
    }) as unknown as typeof fetch;

    const r = await new MoodleGateway(new MoodleClient(fetchFn)).fetch(ctx, { kind: 'tudo' });
    expect(r.courseSpaces).toHaveLength(2);
    expect(r.items!.some((i) => i.courseExternalId === '10')).toBe(true); // itens do curso 10 vieram
    expect(r.grades!.map((g) => g.courseExternalId)).toEqual(['11']); // só as notas do 11
    expect(r.partial).toEqual({ items: [], grades: ['10'] });
    expect(r.warnings![0]).toContain('Cálculo A');
    expect(r.warnings!.join(' ')).not.toContain('SEGREDO123');
  });

  it('token inválido no meio continua derrubando (vira REAUTH_NEEDED)', async () => {
    const { fetchFn } = fakeMoodle({
      gradereport_user_get_grade_items: { exception: 'x', errorcode: 'invalidtoken', message: 'inválido' },
    });
    const err = await new MoodleGateway(new MoodleClient(fetchFn)).fetch(ctx, { kind: 'tudo' }).catch((e) => e);
    expect((err as SourceError).code).toBe('REAUTH_NEEDED');
  });

  it('erro do Moodle não vaza o token', async () => {
    const { fetchFn } = fakeMoodle({
      core_webservice_get_site_info: {
        exception: 'moodle_exception',
        errorcode: 'invalidtoken',
        message: 'Token SEGREDO123 inválido',
      },
    });
    const err = await new MoodleGateway(new MoodleClient(fetchFn))
      .fetch(ctx, { kind: 'tudo' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).code).toBe('REAUTH_NEEDED');
    expect((err as Error).message).not.toContain('SEGREDO123');
  });
});

describe('MoodleAttachmentReader', () => {
  it('anexa token e devolve o binário', async () => {
    let requested = '';
    const fetchFn = ((url: string) => {
      requested = url;
      return Promise.resolve(
        new Response(Buffer.from('PDF'), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="aula1.pdf"',
          },
        }),
      );
    }) as unknown as typeof fetch;
    const out = await new MoodleAttachmentReader(fetchFn).read(
      ctx,
      'https://moodle.test/webservice/pluginfile.php/1/aula1.pdf?forcedownload=1',
    );
    const u = new URL(requested);
    expect(u.searchParams.get('token')).toBe('SEGREDO123');
    expect(u.searchParams.get('forcedownload')).toBe('1');
    expect(out.content.toString()).toBe('PDF');
    expect(out.mimeType).toBe('application/pdf');
    expect(out.fileName).toBe('aula1.pdf');
  });

  it('recusa URL de outro host (não envia o token)', async () => {
    const fetchFn = jest.fn();
    await expect(
      new MoodleAttachmentReader(fetchFn as unknown as typeof fetch).read(ctx, 'https://evil.test/x.pdf'),
    ).rejects.toThrow(MoodleError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falha em HTTP não-OK sem expor o token', async () => {
    const fetchFn = (() => Promise.resolve(new Response('x', { status: 403 }))) as unknown as typeof fetch;
    const err = await new MoodleAttachmentReader(fetchFn)
      .read(ctx, 'https://moodle.test/f.pdf')
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).not.toContain('SEGREDO123');
  });
});
