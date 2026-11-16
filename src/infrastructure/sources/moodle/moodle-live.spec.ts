import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { DriveRefs } from '../drive/drive-refs';
import { htmlToText, MAX_HTML_LEITURAS, MoodleLive } from './moodle-live';

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
    // O link do Drive sai de `links`: o agente deve usar a `ref` do anexo (o link direto pede login).
    expect(por['Material da aula'].links).toEqual([]);
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

describe('MoodleLive: links do Drive dentro de page, book e resource HTML', () => {
  const refs = new DriveRefs(Buffer.alloc(32, 7).toString('base64'));
  const mk = (n: number) => `${n}AbCdEfGhIjKlMnOpQrStUvWxYz012345`;
  const ctx2: SourceContext = { userId: 'u1', accountKey: 'k', siteUrl: 'https://ava.test', credentials: { kind: 'token', token: Secret.of('SEGREDO123') } };
  const file = (id: number, name = 'index.html', extra: object = {}) => ({ filename: name, fileurl: `https://ava.test/pluginfile.php/${id}/${name}?forcedownload=1`, type: 'file', mimetype: 'text/html', filesize: 200, ...extra });

  /** Moodle falso: WS por nome (resposta ou erro) e arquivos por URL; conta o que foi lido. */
  function ava(ws: Record<string, unknown>, html: Record<string, string> = {}) {
    const reads: string[] = [];
    const wsCalls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const fn = (init.body as URLSearchParams).get('wsfunction') as string;
        wsCalls.push(fn);
        const r = ws[fn];
        if (r instanceof Error) return new Response(JSON.stringify({ exception: 'x', errorcode: 'accessexception', message: 'sem acesso' }), { status: 200 });
        return new Response(JSON.stringify(r ?? {}), { status: 200 });
      }
      const u = new URL(url);
      expect(u.searchParams.get('token')).toBe('SEGREDO123'); // o leitor acrescenta o token, só para o Moodle da conta
      reads.push(`${u.pathname}`);
      const body = html[u.pathname];
      return body === undefined ? new Response('x', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    return { live: new MoodleLive(fetchFn, refs), reads, wsCalls };
  }
  const link = (n: number, texto = 'Material') => `<p><a href="https://drive.google.com/file/d/${mk(n)}/view">${texto}</a></p>`;
  const curso = (modules: unknown[]) => ({ core_course_get_contents: [{ id: 1, name: 'S', modules }], mod_assign_get_assignments: { courses: [] } });
  const anexosDe = (a: Array<{ titulo: string; anexos: Array<{ nome: string; ref: string }> }>, titulo: string) => a.find((x) => x.titulo === titulo)!.anexos.filter((x) => x.ref.startsWith('gdrive1.'));

  it('mod_page: o corpo vem de mod_page_get_pages_by_courses (1 chamada para o curso todo) e o link do Drive vira anexo', async () => {
    const { live, wsCalls, reads } = ava({
      ...curso([{ id: 11, name: 'Aula 1', modname: 'page', contents: [file(11)] }, { id: 12, name: 'Aula 2', modname: 'page', contents: [file(12)] }]),
      mod_page_get_pages_by_courses: { pages: [{ coursemodule: 11, content: link(1, 'Slides da aula 1') }, { coursemodule: 12, content: '<p>sem link</p>' }] },
    });
    const a = await live.verCurso(ctx2, '10');
    expect(anexosDe(a, 'Aula 1')).toEqual([expect.objectContaining({ nome: 'Slides da aula 1' })]);
    expect(anexosDe(a, 'Aula 2')).toEqual([]);
    expect(wsCalls.filter((w) => w === 'mod_page_get_pages_by_courses')).toHaveLength(1);
    expect(reads).toEqual([]); // não baixou o index.html: o WS bastou
  });

  it('mod_page com o WS fora do ar: cai no index.html de cada página', async () => {
    const { live, reads } = ava(
      { ...curso([{ id: 11, name: 'Aula 1', modname: 'page', contents: [file(11)] }]), mod_page_get_pages_by_courses: new Error('sem acesso') },
      { '/pluginfile.php/11/index.html': link(2, 'Lista') },
    );
    const a = await live.verCurso(ctx2, '10');
    expect(anexosDe(a, 'Aula 1')).toEqual([expect.objectContaining({ nome: 'Lista' })]);
    expect(reads).toEqual(['/pluginfile.php/11/index.html']);
  });

  it('mod_book (capítulos) e resource HTML: lê o HTML e acha os links; arquivo que não é HTML não é lido', async () => {
    const { live, reads, wsCalls } = ava(
      curso([
        { id: 21, name: 'Livro', modname: 'book', contents: [{ filename: 'structure', fileurl: 'https://ava.test/x/structure', type: 'content', filesize: 50 }, file(211, 'index.html'), file(212, 'index.html')] },
        { id: 22, name: 'Apostila HTML', modname: 'resource', contents: [file(22, 'apostila.html')] },
        { id: 23, name: 'Apostila PDF', modname: 'resource', contents: [file(23, 'a.pdf', { mimetype: 'application/pdf' })] },
      ]),
      { '/pluginfile.php/211/index.html': link(3, 'Cap 1'), '/pluginfile.php/212/index.html': '<p>nada</p>', '/pluginfile.php/22/apostila.html': link(4, 'Apostila') },
    );
    const a = await live.verCurso(ctx2, '10');
    expect(anexosDe(a, 'Livro')).toEqual([expect.objectContaining({ nome: 'Cap 1' })]);
    expect(anexosDe(a, 'Apostila HTML')).toEqual([expect.objectContaining({ nome: 'Apostila' })]);
    expect(anexosDe(a, 'Apostila PDF')).toEqual([]);
    expect(reads.sort()).toEqual(['/pluginfile.php/211/index.html', '/pluginfile.php/212/index.html', '/pluginfile.php/22/apostila.html']);
    expect(wsCalls).not.toContain('mod_page_get_pages_by_courses'); // sem módulo page, nenhuma chamada extra
  });

  it('teto de leituras HTML por curso, HTML grande e módulo oculto não são lidos; falha de leitura não derruba', async () => {
    const mods = [
      ...Array.from({ length: MAX_HTML_LEITURAS + 5 }, (_, i) => ({ id: 100 + i, name: `R${i}`, modname: 'resource', contents: [file(100 + i, 'a.html')] })),
      { id: 900, name: 'Grande', modname: 'resource', contents: [file(900, 'g.html', { filesize: 600 * 1024 })] },
      { id: 901, name: 'Oculto', modname: 'resource', visible: 0, contents: [file(901, 'o.html')] },
    ];
    const { live, reads } = ava(curso(mods)); // todos respondem 404: melhor esforço
    const a = await live.verCurso(ctx2, '10');
    expect(reads).toHaveLength(MAX_HTML_LEITURAS);
    expect(reads.some((r) => r.includes('/900/') || r.includes('/901/'))).toBe(false);
    expect(a.length).toBeGreaterThan(MAX_HTML_LEITURAS);
  });

  it('o link do Drive que virou anexo sai de links (o agente usa a ref, não o link que pede login)', async () => {
    const url = `https://drive.google.com/file/d/${mk(5)}/view`;
    const { live } = ava(curso([{ id: 31, name: 'Link', modname: 'url', contents: [{ filename: 'x', fileurl: url, type: 'url' }] }, { id: 32, name: 'Outro', modname: 'url', contents: [{ filename: 'y', fileurl: 'https://exemplo.com/a', type: 'url' }] }]));
    const a = await live.verCurso(ctx2, '10');
    expect(a[0].links).toEqual([]);
    expect(a[0].anexos.filter((x) => x.ref.startsWith('gdrive1.'))).toHaveLength(1);
    expect(a[1].links).toEqual(['https://exemplo.com/a']);
  });

  it('sem DriveRefs: não lê HTML nenhum e os links ficam em links', async () => {
    const reads: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.body) return new Response(JSON.stringify(curso([{ id: 21, name: 'Livro', modname: 'book', contents: [file(211)] }, { id: 32, name: 'L', modname: 'url', contents: [{ filename: 'y', fileurl: `https://drive.google.com/file/d/${mk(6)}/view`, type: 'url' }] }])[(init.body as URLSearchParams).get('wsfunction') as 'core_course_get_contents'] ?? {}), { status: 200 });
      reads.push(url);
      return new Response('<p>x</p>');
    }) as unknown as typeof fetch;
    const a = await new MoodleLive(fetchFn).verCurso(ctx2, '10');
    expect(reads).toEqual([]);
    expect(a.find((x) => x.titulo === 'L')!.links).toEqual([`https://drive.google.com/file/d/${mk(6)}/view`]);
  });
});
