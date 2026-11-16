import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { DriveRefs } from '../drive/drive-refs';
import { htmlToText, MoodleLive } from './moodle-live';

const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'ava.test:aluno',
  siteUrl: 'https://ava.test',
  credentials: { kind: 'token', token: Secret.of('SEGREDO123') },
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

describe('MoodleLive: arquivos do Drive linkados no curso', () => {
  const ID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const ID2 = '2BbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const ID3 = '3CbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const refs = new DriveRefs(Buffer.alloc(32, 7).toString('base64'));

  function com(responses: Record<string, unknown>, drive?: DriveRefs) {
    const fetchFn = (async (_u: string, init: RequestInit) =>
      new Response(JSON.stringify(responses[(init.body as URLSearchParams).get('wsfunction') as string] ?? {}), { status: 200 })) as unknown as typeof fetch;
    return new MoodleLive(fetchFn, drive);
  }
  const curso = {
    core_course_get_contents: [
      {
        id: 1,
        name: 'Semana 1',
        modules: [
          {
            id: 1,
            name: 'Material da aula',
            modname: 'url',
            contents: [{ filename: 'slides', fileurl: `https://docs.google.com/presentation/d/${ID1}/edit?usp=sharing`, type: 'url' }],
          },
          {
            id: 2,
            name: 'Lista',
            modname: 'page',
            description: `<p>Baixe: <a href="https://drive.google.com/file/d/${ID2}/view">Lista 1</a> e a pasta <a href="https://drive.google.com/drive/folders/${ID3}">fotos</a></p>`,
          },
          { id: 3, name: 'Texto solto', modname: 'label', description: `<p>Resumo: https://docs.google.com/spreadsheets/d/${ID3}/edit</p>` },
          { id: 4, name: 'Rótulo sem arquivo', modname: 'label', description: '<p>Bem-vindos</p>' },
          { id: 5, name: 'Link externo', modname: 'url', contents: [{ filename: 'x', fileurl: 'https://exemplo.com/a', type: 'url' }] },
        ],
      },
    ],
    mod_assign_get_assignments: { courses: [{ assignments: [{ cmid: 6, intro: `<a href="https://docs.google.com/document/d/${ID1}/edit">Enunciado</a>`, duedate: 0 }] }] },
  };

  it('links do Drive/Docs (URL do módulo, HTML da descrição, rótulo com arquivo) viram anexos com ref ASSINADO; o resto não', async () => {
    const live = com(curso, refs);
    const a = await live.verCurso({ userId: 'u1', accountKey: 'k', siteUrl: 'https://ava.test', credentials: { kind: 'token', token: { reveal: () => 't' } as never } }, '10');
    const por = Object.fromEntries(a.map((x) => [x.titulo, x]));
    expect(a.map((x) => x.titulo)).toEqual(['Material da aula', 'Lista', 'Texto solto', 'Link externo']); // rótulo sem arquivo continua ignorado
    expect(por['Material da aula'].anexos).toEqual([expect.objectContaining({ nome: 'Apresentação do Google', mimeType: 'application/pdf' })]);
    expect(por['Lista'].anexos).toEqual([expect.objectContaining({ nome: 'Lista 1' })]); // a pasta não vira anexo
    expect(por['Texto solto'].anexos).toEqual([expect.objectContaining({ nome: 'Planilha do Google', mimeType: expect.stringContaining('spreadsheetml') })]);
    expect(por['Link externo'].anexos).toEqual([]);
    // O ref é opaco, assinado e preso à pessoa; não carrega a URL.
    for (const x of a.flatMap((y) => y.anexos)) {
      expect(x.ref).toMatch(/^gdrive1\./);
      expect(x.ref).not.toContain('http');
      expect(refs.verify('u1', x.ref)).not.toBeNull();
      expect(refs.verify('u2', x.ref)).toBeNull();
    }
    // O link original continua em `links` (informação), e agora também há o anexo para baixar.
    expect(por['Material da aula'].links).toEqual([`https://docs.google.com/presentation/d/${ID1}/edit?usp=sharing`]);
  });

  it('descrição de tarefa (intro) também vale', async () => {
    const live = com({ core_course_get_contents: [{ id: 1, name: 'S', modules: [{ id: 6, name: 'Trabalho', modname: 'assign' }] }], mod_assign_get_assignments: curso.mod_assign_get_assignments }, refs);
    const [t] = await live.verCurso({ userId: 'u1', accountKey: 'k', siteUrl: 'https://ava.test', credentials: { kind: 'token', token: { reveal: () => 't' } as never } }, '10');
    expect(t.anexos).toEqual([expect.objectContaining({ nome: 'Enunciado' })]);
  });

  it('verForum: links do Drive na mensagem viram anexos', async () => {
    const live = com(
      { mod_forum_get_forum_discussions: { discussions: [{ id: 1, discussion: 9, name: 'Material', message: `<p><a href="https://drive.google.com/open?id=${ID2}">Notas</a></p>`, attachments: [] }] } },
      refs,
    );
    const [d] = await live.verForum({ userId: 'u1', accountKey: 'k', siteUrl: 'https://ava.test', credentials: { kind: 'token', token: { reveal: () => 't' } as never } }, '77');
    expect(d.anexos).toEqual([expect.objectContaining({ nome: 'Notas', ref: expect.stringMatching(/^gdrive1\.file\./) })]);
  });

  it('sem DriveRefs (SECRETS_KEY ausente) o recurso fica desligado: nenhum anexo do Drive nasce', async () => {
    const live = com(curso);
    const a = await live.verCurso({ userId: 'u1', accountKey: 'k', siteUrl: 'https://ava.test', credentials: { kind: 'token', token: { reveal: () => 't' } as never } }, '10');
    expect(a.flatMap((x) => x.anexos)).toEqual([]);
    expect(a.map((x) => x.titulo)).toEqual(['Material da aula', 'Lista', 'Link externo']);
  });
});
