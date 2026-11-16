import { Secret } from '../../../application/shared/secret';
import { SourceError } from '../../../application/ports/source-gateway';
import { GoogleApiError, type GoogleHttp } from '../google/google-http';
import { DriveRefs } from './drive-refs';
import { GoogleDriveDownloader, MAX_DRIVE_BYTES, MAX_FOLDER_ITEMS, SEM_ACESSO, blockMessage, googleHost, humanSize } from './google-drive-downloader';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const refs = new DriveRefs(KEY);
const U = 'u1';
const SEGREDO = 'refresh-token-canario';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

type Call = { url: string; params: Record<string, string | undefined> };

/** GoogleHttp falso: `rotas` responde por (id|método). Nunca toca a rede. */
function fakeHttp(handler: (c: Call) => Response | GoogleApiError) {
  const calls: Call[] = [];
  const http = {
    get: async (rt: Secret, url: string, params: Record<string, string | undefined> = {}) => {
      expect(rt.reveal()).toBe(SEGREDO);
      calls.push({ url, params });
      const r = handler({ url, params });
      if (r instanceof GoogleApiError) throw r;
      return r;
    },
  } as unknown as GoogleHttp;
  return { http, calls };
}
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const conta = (accountKey: string) => ({ accountKey, refreshToken: Secret.of(SEGREDO) });

function build(opts: { ufba?: GoogleHttp; convidado?: GoogleHttp; fetchFn?: typeof fetch; apiKey?: string } = {}) {
  return new GoogleDriveDownloader(refs, { ufba: opts.ufba, convidado: opts.convidado }, { dominio: 'ufba.br', fetchFn: opts.fetchFn, apiKey: opts.apiKey });
}
const noNet = (async () => {
  throw new Error('rede proibida neste teste');
}) as unknown as typeof fetch;

describe('GoogleDriveDownloader: com o token da pessoa', () => {
  it('arquivo comum: entrega como ele é (nome e tipo do Drive)', async () => {
    const { http, calls } = fakeHttp(({ params }) =>
      params.alt === 'media' ? new Response(bytes('%PDF-1.7 aula'), { status: 200 }) : json({ id: ID, name: 'aula1.pdf', mimeType: 'application/pdf', size: '13' }),
    );
    const f = await build({ ufba: http, fetchFn: noNet }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]);
    expect(f).toMatchObject({ mimeType: 'application/pdf', fileName: 'aula1.pdf' });
    expect(text(f.bytes)).toBe('%PDF-1.7 aula');
    expect(calls.map((c) => c.url)).toEqual([`https://www.googleapis.com/drive/v3/files/${ID}`, `https://www.googleapis.com/drive/v3/files/${ID}`]);
  });

  it.each([
    ['application/vnd.google-apps.document', 'Aula 1', 'application/pdf', 'Aula 1.pdf'],
    ['application/vnd.google-apps.presentation', 'Slides', 'application/pdf', 'Slides.pdf'],
    ['application/vnd.google-apps.spreadsheet', 'Notas', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Notas.xlsx'],
  ])('nativo %s é exportado (Docs e Apresentações → PDF, Planilhas → XLSX)', async (nativo, nome, mimeEsperado, arquivo) => {
    const { http, calls } = fakeHttp(({ url, params }) =>
      url.endsWith('/export') ? new Response(bytes('exportado'), { status: 200 }) : json({ id: ID, name: nome, mimeType: nativo }),
    );
    const f = await build({ ufba: http }).download(U, refs.sign(U, { kind: 'doc', id: ID }), [conta('a@ufba.br')]);
    expect(f).toMatchObject({ mimeType: mimeEsperado, fileName: arquivo });
    expect(calls.at(-1)).toMatchObject({ url: `https://www.googleapis.com/drive/v3/files/${ID}/export`, params: { mimeType: mimeEsperado } });
  });

  it('tipo nativo sem exportação (pasta, formulário): 400 claro, sem tentar o link público', async () => {
    const { http } = fakeHttp(() => json({ id: ID, name: 'Form', mimeType: 'application/vnd.google-apps.form' }));
    await expect(build({ ufba: http, fetchFn: noNet }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
  });

  it('a conta @ufba.br é tentada primeiro; sem acesso nela (403), vai para a conta de convidado', async () => {
    const ordem: string[] = [];
    const ufba = fakeHttp(() => {
      ordem.push('ufba');
      return new GoogleApiError(403, 'Google API 403');
    });
    const convidado = fakeHttp(({ params }) => {
      ordem.push('convidado');
      return params.alt === 'media' ? new Response(bytes('ok'), { status: 200 }) : json({ name: 'x.txt', mimeType: 'text/plain' });
    });
    const f = await build({ ufba: ufba.http, convidado: convidado.http }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('eu@gmail.com'), conta('eu@ufba.br')]);
    expect(text(f.bytes)).toBe('ok');
    expect(ordem).toEqual(['ufba', 'convidado', 'convidado']);
  });

  it('arquivo maior que o teto: recusa antes de baixar (pelo size do Drive)', async () => {
    const { http, calls } = fakeHttp(() => json({ name: 'grande.zip', mimeType: 'application/zip', size: String(MAX_DRIVE_BYTES + 1) }));
    await expect(build({ ufba: http }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    expect(calls).toHaveLength(1); // só os metadados
  });

  it('corpo que passa do teto sem avisar: aborta a leitura', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
    });
    const { http } = fakeHttp(({ params }) => (params.alt === 'media' ? new Response(stream, { status: 200 }) : json({ name: 'x.bin', mimeType: 'application/octet-stream' })));
    await expect(build({ ufba: http }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
  });
});

describe('GoogleDriveDownloader: link público (depois do token)', () => {
  const semAcesso = () => new GoogleApiError(404, 'Google API 404');

  it('sem nenhuma conta do Google: baixa pelo link público (sem login), com redirect só dentro do Google', async () => {
    const vistos: string[] = [];
    const fetchFn = (async (url: string) => {
      vistos.push(url);
      if (url.startsWith('https://drive.usercontent.google.com/download')) {
        return new Response(null, { status: 302, headers: { location: 'https://doc-0k-7k-docs.googleusercontent.com/docs/abc' } });
      }
      return new Response(bytes('conteudo'), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="lista.pdf"; filename*=UTF-8''lista%20final.pdf` } });
    }) as unknown as typeof fetch;
    const f = await build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), []);
    expect(f).toMatchObject({ mimeType: 'application/pdf', fileName: 'lista final.pdf' });
    expect(text(f.bytes)).toBe('conteudo');
    expect(vistos).toEqual([`https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`, 'https://doc-0k-7k-docs.googleusercontent.com/docs/abc']);
  });

  it.each([
    ['doc', `https://docs.google.com/document/d/${ID}/export?format=pdf`, 'application/pdf'],
    ['slides', `https://docs.google.com/presentation/d/${ID}/export?format=pdf`, 'application/pdf'],
    ['sheet', `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ] as const)('nativo público (%s) é exportado em %s', async (kind, esperado, mime) => {
    const vistos: string[] = [];
    const fetchFn = (async (url: string) => {
      vistos.push(url);
      return new Response(bytes('x'), { status: 200, headers: { 'content-type': mime } });
    }) as unknown as typeof fetch;
    const f = await build({ fetchFn }).download(U, refs.sign(U, { kind, id: ID }), []);
    expect(vistos).toEqual([esperado]);
    expect(f.mimeType).toBe(mime);
    expect(f.fileName).toMatch(/\.(pdf|xlsx)$/);
  });

  it('token sem acesso (404) cai no link público', async () => {
    const { http } = fakeHttp(semAcesso);
    const fetchFn = (async () => new Response(bytes('publico'), { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const f = await build({ ufba: http, fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]);
    expect(text(f.bytes)).toBe('publico');
  });

  it('privado: redirect para o login do Google = sem acesso, com a dica de conectar o Classroom', async () => {
    const fetchFn = (async () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?x=1' } })) as unknown as typeof fetch;
    const e = await build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), []).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e).toMatchObject({ code: 'NO_ACCESS', message: SEM_ACESSO });
    expect(SEM_ACESSO).toMatch(/Classroom/);
  });

  it('HTML no lugar do arquivo (página de aviso/login) é sem acesso, não é entregue como arquivo', async () => {
    const fetchFn = (async () => new Response('<html>Entrar</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
    await expect(build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [])).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });

  it('redirect para host de fora do Google NÃO é seguido (nenhuma requisição ao host de fora)', async () => {
    const vistos: string[] = [];
    const fetchFn = (async (url: string) => {
      vistos.push(url);
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/roubo' } });
    }) as unknown as typeof fetch;
    await expect(build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [])).rejects.toMatchObject({ code: 'NO_ACCESS' });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]).toMatch(/^https:\/\/drive\.usercontent\.google\.com\//);
  });

  it('laço de redirects é cortado', async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response(null, { status: 302, headers: { location: 'https://drive.google.com/loop' } });
    }) as unknown as typeof fetch;
    await expect(build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [])).rejects.toMatchObject({ code: 'NO_ACCESS' });
    expect(n).toBeLessThanOrEqual(6);
  });

  it('falha de rede/5xx não vira "sem acesso": é indisponibilidade passageira', async () => {
    const { http } = fakeHttp(() => new GoogleApiError(503, 'Google API 503'));
    const fetchFn = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(build({ ufba: http, fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('público grande demais é cortado pelo content-length', async () => {
    const fetchFn = (async () => new Response('x', { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(MAX_DRIVE_BYTES + 1) } })) as unknown as typeof fetch;
    await expect(build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
  });
});

describe('GoogleDriveDownloader: só aceita o ref que saiu do curso desta pessoa', () => {
  it('ref fabricado, adulterado ou de outra pessoa: recusa sem tocar rede nem token', async () => {
    const touched: string[] = [];
    const { http } = fakeHttp((c) => {
      touched.push(c.url);
      return json({});
    });
    const fetchFn = (async (u: string) => {
      touched.push(u);
      return new Response('x');
    }) as unknown as typeof fetch;
    const d = build({ ufba: http, fetchFn });
    for (const ref of [`gdrive1.file.${ID}.assinaturafalsa`, refs.sign('outra', { kind: 'file', id: ID }), `https://drive.google.com/file/d/${ID}/view`, `gdrive1.file.${ID}`]) {
      await expect(d.download(U, ref, [conta('a@ufba.br')])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    }
    expect(touched).toEqual([]);
  });

  it('o token e o conteúdo nunca aparecem nas mensagens de erro', async () => {
    const { http } = fakeHttp(() => new GoogleApiError(403, 'Google API 403'));
    const fetchFn = (async () => new Response('<html>privado</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const e = await build({ ufba: http, fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]).catch((x) => x);
    expect(String(e.message) + JSON.stringify(e)).not.toContain(SEGREDO);
  });
});

describe('googleHost', () => {
  it.each(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com', 'doc-0k.googleusercontent.com', 'DOCS.GOOGLE.COM'])('aceita %s', (h) => expect(googleHost(h)).toBe(true));
  it.each(['accounts.google.com', 'google.com', 'evil.example', 'googleusercontent.com.evil.example', 'xgoogleusercontent.com', 'drive.google.com.evil.example'])('recusa %s', (h) => expect(googleHost(h)).toBe(false));
});

const MB = 1024 * 1024;
const FILE_ID = (n: number) => `${String(n).padStart(2, '0')}AbCdEfGhIjKlMnOpQrStUvWxYz0123`;

describe('vídeo e arquivo grande: NÃO baixa, diz o que é e dá o link para abrir no navegador', () => {
  it('vídeo pequeno também é recusado pelos metadados, sem baixar o corpo', async () => {
    const { http, calls } = fakeHttp(() => json({ name: 'Aula 01.mp4', mimeType: 'video/mp4', size: String(10 * MB) }));
    const e = await build({ ufba: http, fetchFn: noNet }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(e.message).toBe(`"Aula 01.mp4" é um vídeo (10 MB): abra no navegador: https://drive.google.com/file/d/${ID}/view`);
    expect(calls).toHaveLength(1); // só os metadados
  });

  it('arquivo acima do teto: nome, tamanho, o limite e o link', async () => {
    const { http, calls } = fakeHttp(() => json({ name: 'gravacao.zip', mimeType: 'application/zip', size: String(350 * MB) }));
    const e = await build({ ufba: http }).download(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]).catch((x) => x);
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(e.message).toBe(`"gravacao.zip" é grande demais (350 MB), o limite é 25 MB: abra no navegador: https://drive.google.com/file/d/${ID}/view`);
    expect(calls).toHaveLength(1);
  });

  it('o link para a pessoa de um nativo do Google é o de edição (docs.google.com), não o da API', async () => {
    const { http } = fakeHttp(() => json({ name: 'Tudo', mimeType: 'application/vnd.google-apps.document' }));
    // nativo sem size: baixa (exporta) normal; aqui só conferimos que não é bloqueado
    const f = await build({ ufba: http, fetchFn: noNet }).download(U, refs.sign(U, { kind: 'doc', id: ID }), [conta('a@ufba.br')]).catch((x) => x);
    expect(f).not.toBeInstanceOf(SourceError);
  });

  it('link público que responde vídeo: recusa pelo content-type, sem ler o corpo', async () => {
    let cancelado = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelado = true;
      },
    });
    const fetchFn = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(400 * MB), 'content-disposition': 'attachment; filename="aula.mp4"' } })) as unknown as typeof fetch;
    const e = await build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), []).catch((x) => x);
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(e.message).toMatch(/"aula.mp4" é um vídeo \(400 MB\)/);
    expect(e.message).toContain(`https://drive.google.com/file/d/${ID}/view`);
    expect(cancelado).toBe(true); // o corpo foi descartado, não lido até o fim
  });

  it('público grande demais: a mensagem agora traz o tamanho e o link', async () => {
    const fetchFn = (async () => new Response('x', { status: 200, headers: { 'content-type': 'application/zip', 'content-length': String(90 * MB) } })) as unknown as typeof fetch;
    const e = await build({ fetchFn }).download(U, refs.sign(U, { kind: 'file', id: ID }), []).catch((x) => x);
    expect(e.message).toMatch(/\(90 MB\), o limite é 25 MB: abra no navegador: https:\/\/drive\.google\.com\/file\/d\//);
  });

  it('humanSize e blockMessage', () => {
    expect(humanSize(350 * MB)).toBe('350 MB');
    expect(humanSize(800 * 1024)).toBe('800 KB');
    expect(humanSize(1.5 * 1024 * MB)).toBe('1,5 GB');
    expect(blockMessage('x.mp4', 'video', null, 'https://u')).toBe('"x.mp4" é um vídeo: abra no navegador: https://u');
  });
});

describe('inspect: metadados antes de gerar o link', () => {
  it('com o token: nome, tipo, tamanho, bloqueio e link; folder e ref inválido não passam', async () => {
    const { http } = fakeHttp(() => json({ name: 'Aula 01.mp4', mimeType: 'video/mp4', size: String(350 * MB) }));
    const d = build({ ufba: http });
    const info = await d.inspect(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]);
    expect(info).toMatchObject({ name: 'Aula 01.mp4', mimeType: 'video/mp4', sizeBytes: 350 * MB, blocked: 'video', viewUrl: `https://drive.google.com/file/d/${ID}/view` });
    expect(info!.message).toMatch(/vídeo \(350 MB\)/);
    expect(await d.inspect(U, refs.sign(U, { kind: 'folder', id: ID }), [conta('a@ufba.br')])).toBeNull();
    await expect(d.inspect(U, 'gdrive1.file.x.y', [])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
  });

  it('arquivo comum pequeno: blocked null', async () => {
    const { http } = fakeHttp(() => json({ name: 'a.pdf', mimeType: 'application/pdf', size: '1000' }));
    expect((await build({ ufba: http }).inspect(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')]))!.blocked).toBeNull();
  });

  it('sem token e sem chave pública: null (não sabe); com a chave pública: usa a API oficial, e a chave nunca aparece em saída', async () => {
    expect(await build({ fetchFn: noNet }).inspect(U, refs.sign(U, { kind: 'file', id: ID }), [])).toBeNull();
    const vistos: string[] = [];
    const fetchFn = (async (u: URL) => {
      vistos.push(String(u));
      return new Response(JSON.stringify({ name: 'v.mp4', mimeType: 'video/mp4', size: String(99 * MB) }), { status: 200 });
    }) as unknown as typeof fetch;
    const info = await build({ fetchFn, apiKey: 'CHAVE-CANARIO' }).inspect(U, refs.sign(U, { kind: 'file', id: ID }), []);
    expect(info!.blocked).toBe('video');
    expect(vistos[0]).toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\//);
    expect(JSON.stringify(info)).not.toContain('CHAVE-CANARIO');
  });

  it('403 do token cai na chave pública; falha da chave também dá null, sem lançar nem vazar a chave', async () => {
    const { http } = fakeHttp(() => new GoogleApiError(403, 'Google API 403'));
    const fetchFn = (async () => {
      throw new Error('falhou https://www.googleapis.com/x?key=CHAVE-CANARIO');
    }) as unknown as typeof fetch;
    expect(await build({ ufba: http, fetchFn, apiKey: 'CHAVE-CANARIO' }).inspect(U, refs.sign(U, { kind: 'file', id: ID }), [conta('a@ufba.br')])).toBeNull();
  });
});

describe('listFolder: o primeiro nível de uma pasta do Drive', () => {
  const pasta = () => refs.sign(U, { kind: 'folder', id: ID });
  const listagem = (...files: object[]) => json({ files });

  it('um item por arquivo: nome, tipo, tamanho e ref ASSINADO para esta pessoa; a consulta é só "filhos da pasta"', async () => {
    const { http, calls } = fakeHttp(() =>
      listagem(
        { id: FILE_ID(1), name: 'Aula 1.pdf', mimeType: 'application/pdf', size: '2048' },
        { id: FILE_ID(2), name: 'Notas', mimeType: 'application/vnd.google-apps.spreadsheet' },
        { id: FILE_ID(3), name: 'Slides', mimeType: 'application/vnd.google-apps.presentation' },
      ),
    );
    const entries = (await build({ ufba: http }).listFolder(U, pasta(), [conta('a@ufba.br')]))!;
    expect(entries.map((e) => [e.name, e.mimeType, e.sizeBytes, e.isFolder])).toEqual([
      ['Aula 1.pdf', 'application/pdf', 2048, false],
      ['Notas', 'application/vnd.google-apps.spreadsheet', null, false],
      ['Slides', 'application/vnd.google-apps.presentation', null, false],
    ]);
    // Os filhos nascem assinados: valem para esta pessoa, não para outra, e o tipo do ref vem do mimeType.
    expect(entries.map((e) => e.ref!.split('.')[1])).toEqual(['file', 'sheet', 'slides']);
    for (const e of entries) {
      expect(refs.verify(U, e.ref!)).not.toBeNull();
      expect(refs.verify('outra', e.ref!)).toBeNull();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.googleapis.com/drive/v3/files');
    expect(calls[0].params.q).toBe(`'${ID}' in parents and trashed = false`);
    expect(calls[0].params.pageSize).toBe(String(MAX_FOLDER_ITEMS));
  });

  it('vídeo, arquivo grande e subpasta NÃO ganham ref: ficam com rótulo, tipo e link para abrir no navegador', async () => {
    const { http } = fakeHttp(() =>
      listagem(
        { id: FILE_ID(1), name: 'Aula 01.mp4', mimeType: 'video/mp4', size: String(350 * MB) },
        { id: FILE_ID(2), name: 'turma.zip', mimeType: 'application/zip', size: String(90 * MB) },
        { id: FILE_ID(3), name: 'Material extra', mimeType: 'application/vnd.google-apps.folder' },
        { id: FILE_ID(4), name: 'ok.pdf', mimeType: 'application/pdf', size: '10' },
      ),
    );
    const e = (await build({ ufba: http }).listFolder(U, pasta(), [conta('a@ufba.br')]))!;
    expect(e.map((x) => x.ref !== null)).toEqual([false, false, false, true]);
    expect(e.map((x) => x.label)).toEqual(['Aula 01.mp4 (vídeo, 350 MB)', 'turma.zip (grande demais, 90 MB)', 'Material extra (subpasta)', 'ok.pdf']);
    expect(e[0].viewUrl).toBe(`https://drive.google.com/file/d/${FILE_ID(1)}/view`);
    expect(e[2]).toMatchObject({ isFolder: true, viewUrl: `https://drive.google.com/drive/folders/${FILE_ID(3)}` });
  });

  it('teto de itens; id estranho no meio da listagem é descartado', async () => {
    const many = Array.from({ length: MAX_FOLDER_ITEMS + 30 }, (_, i) => ({ id: FILE_ID(i % 90), name: `f${i}`, mimeType: 'application/pdf', size: '1' }));
    const { http } = fakeHttp(() => listagem(...many, { id: "x'; drop", name: 'mau', mimeType: 'application/pdf' }));
    const e = (await build({ ufba: http }).listFolder(U, pasta(), [conta('a@ufba.br')]))!;
    expect(e).toHaveLength(MAX_FOLDER_ITEMS);
    expect(e.some((x) => x.name === 'mau')).toBe(false);
  });

  it('a conta @ufba.br primeiro; sem acesso nela, a de convidado; sem nenhuma e sem chave: null', async () => {
    const ordem: string[] = [];
    const ufba = fakeHttp(() => {
      ordem.push('ufba');
      return new GoogleApiError(404, 'Google API 404');
    });
    const convidado = fakeHttp(() => {
      ordem.push('convidado');
      return listagem({ id: FILE_ID(1), name: 'a.pdf', mimeType: 'application/pdf' });
    });
    const e = await build({ ufba: ufba.http, convidado: convidado.http }).listFolder(U, pasta(), [conta('eu@gmail.com'), conta('eu@ufba.br')]);
    expect(e).toHaveLength(1);
    expect(ordem).toEqual(['ufba', 'convidado']);
    expect(await build({ fetchFn: noNet }).listFolder(U, pasta(), [])).toBeNull();
  });

  it('pasta pública com a chave do servidor: lista pela API oficial; a chave nunca sai', async () => {
    const vistos: string[] = [];
    const fetchFn = (async (u: URL) => {
      vistos.push(String(u));
      return new Response(JSON.stringify({ files: [{ id: FILE_ID(1), name: 'p.pdf', mimeType: 'application/pdf', size: '5' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = await build({ fetchFn, apiKey: 'CHAVE-CANARIO' }).listFolder(U, pasta(), []);
    expect(e![0].name).toBe('p.pdf');
    expect(vistos[0]).toContain('key=CHAVE-CANARIO'); // vai só na requisição ao Google
    expect(JSON.stringify(e)).not.toContain('CHAVE-CANARIO');
  });

  it('ref de arquivo (não pasta) devolve null; ref forjado é recusado; baixar uma PASTA explica e dá o link', async () => {
    const d = build({});
    expect(await d.listFolder(U, refs.sign(U, { kind: 'file', id: ID }), [])).toBeNull();
    await expect(d.listFolder(U, 'gdrive1.folder.x.y', [])).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    const e = await d.download(U, pasta(), []).catch((x) => x);
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(e.message).toContain(`https://drive.google.com/drive/folders/${ID}`);
  });

  it('isFolder e viewUrl', () => {
    const d = build({});
    expect(d.isFolder(pasta())).toBe(true);
    expect(d.isFolder(refs.sign(U, { kind: 'file', id: ID }))).toBe(false);
    expect(d.viewUrl(U, pasta())).toBe(`https://drive.google.com/drive/folders/${ID}`);
    expect(d.viewUrl('outra', pasta())).toBeNull();
  });
});
