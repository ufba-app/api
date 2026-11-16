import { Secret } from '../../../application/shared/secret';
import { SourceError } from '../../../application/ports/source-gateway';
import { GoogleApiError, type GoogleHttp } from '../google/google-http';
import { DriveRefs } from './drive-refs';
import { GoogleDriveDownloader, MAX_DRIVE_BYTES, SEM_ACESSO, googleHost } from './google-drive-downloader';

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

function build(opts: { ufba?: GoogleHttp; convidado?: GoogleHttp; fetchFn?: typeof fetch } = {}) {
  return new GoogleDriveDownloader(refs, { ufba: opts.ufba, convidado: opts.convidado }, { dominio: 'ufba.br', fetchFn: opts.fetchFn });
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
