import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { htmlToText, MoodleLive } from './moodle-live';

const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'ava.test:aluno',
  siteUrl: 'https://ava.test',
  credentials: { kind: 'token', token: 'SEGREDO123' },
};

function moodle(responses: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    calls.push(body);
    return new Response(JSON.stringify(responses[body.get('wsfunction') as string] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { live: new MoodleLive(fetchFn), calls };
}

describe('MoodleLive', () => {
  it('listarCursos pede só "inprogress" por padrão e "all" com todas', async () => {
    const { live, calls } = moodle({ core_course_get_enrolled_courses_by_timeline_classification: { courses: [] } });
    await live.listarCursos(ctx);
    await live.listarCursos(ctx, { todas: true });
    expect(calls.map((c) => c.get('classification'))).toEqual(['inprogress', 'all']);
    expect(calls[0].get('wstoken')).toBe('SEGREDO123');
  });

  it('verCurso traz fórum com forumId (instance) e ignora rótulos e ocultos', async () => {
    const { live } = moodle({
      core_course_get_contents: [
        {
          id: 1,
          name: 'Geral',
          modules: [
            { id: 1, instance: 77, name: 'Avisos', modname: 'forum' },
            { id: 2, name: 'Rótulo', modname: 'label' },
            { id: 3, name: 'Escondido', modname: 'resource', visible: 0 },
            { id: 4, name: 'Restrito', modname: 'resource', uservisible: false },
            { id: 5, name: 'Link', modname: 'url', contents: [{ filename: 'x', fileurl: 'https://ex.com', type: 'url' }] },
          ],
        },
      ],
      mod_assign_get_assignments: { courses: [] },
    });
    const a = await live.verCurso(ctx, '10');
    expect(a.map((x) => x.titulo)).toEqual(['Avisos', 'Link']);
    expect(a[0]).toMatchObject({ tipo: 'forum', forumId: '77' });
    expect(a[1]).toMatchObject({ tipo: 'material', links: ['https://ex.com'], anexos: [] });
  });

  it('verForum: 1 chamada, mensagem em texto e anexos', async () => {
    const { live, calls } = moodle({
      mod_forum_get_forum_discussions: {
        discussions: [
          {
            id: 1,
            discussion: 9,
            name: 'Prova adiada',
            message: '<p>Nova data:<br>dia 10</p>',
            userfullname: 'Prof. X',
            created: 1700000000,
            attachments: [{ filename: 'a.pdf', fileurl: 'https://ava.test/pluginfile.php/1/a.pdf?token=VAZOU' }],
          },
        ],
      },
    });
    const [d] = await live.verForum(ctx, '77');
    expect(calls).toHaveLength(1);
    expect(d).toMatchObject({ id: '9', titulo: 'Prova adiada', mensagem: 'Nova data:\ndia 10', autor: 'Prof. X' });
    expect(d.anexos[0].ref).not.toContain('token=');
  });

  it('ids inválidos não chegam ao Moodle', async () => {
    const { live, calls } = moodle({});
    await expect(live.verCurso(ctx, 'abc')).rejects.toBeInstanceOf(SourceError);
    await expect(live.verForum(ctx, '1;2')).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
  });

  it('token recusado vira REAUTH_NEEDED sem vazar o token', async () => {
    const { live } = moodle({
      core_calendar_get_calendar_upcoming_view: { exception: 'x', errorcode: 'invalidtoken', message: 'Token SEGREDO123 inválido' },
    });
    const err = (await live.prazos(ctx).catch((e) => e)) as SourceError;
    expect(err).toBeInstanceOf(SourceError);
    expect(err.code).toBe('REAUTH_NEEDED');
    expect(err.message).not.toContain('SEGREDO123');
  });

  it('falha de rede vira UNAVAILABLE com o código da causa', async () => {
    const live = new MoodleLive((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    }) as unknown as typeof fetch);
    const err = (await live.prazos(ctx).catch((e) => e)) as SourceError;
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('baixar recusa URL de outro host (o token não sai do Moodle da conta)', async () => {
    const fetchFn = jest.fn();
    const live = new MoodleLive(fetchFn as unknown as typeof fetch);
    await expect(live.baixar(ctx, 'https://evil.example/pluginfile.php/1/a.pdf')).rejects.toBeInstanceOf(SourceError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('htmlToText', () => {
  it('tira marcação e entidades', () => {
    expect(htmlToText('<p>A &amp; B</p><p>C&nbsp;D</p>')).toBe('A & B\nC D');
    expect(htmlToText('')).toBeUndefined();
  });
});
