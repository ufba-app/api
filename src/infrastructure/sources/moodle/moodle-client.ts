import type { MoodleAccess } from './moodle-access';

export type FetchFn = typeof fetch;

export class MoodleError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

/** Remove o token de qualquer texto antes de virar mensagem de erro. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

/** Nome de arquivo seguro para o Moodle: só o último segmento, sem controle, até 255 caracteres (preserva a extensão). */
export function nomeSeguro(nome: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (nome.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const limpo = base === '' || base === '.' || base === '..' ? 'arquivo' : base;
  if (limpo.length <= 255) return limpo;
  const ponto = limpo.lastIndexOf('.');
  const ext = ponto > 0 && limpo.length - ponto <= 32 ? limpo.slice(ponto) : '';
  return limpo.slice(0, 255 - ext.length) + ext;
}

/** Cliente fino da Web Service REST do Moodle (POST /webservice/rest/server.php). */
export class MoodleClient {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async call<T>(
    ctx: MoodleAccess,
    wsfunction: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const body = new URLSearchParams({
      wstoken: ctx.token.reveal(),
      wsfunction,
      moodlewsrestformat: 'json',
    });
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));

    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/webservice/rest/server.php`;
    const res = await this.fetchFn(url, { method: 'POST', body });
    if (!res.ok) {
      throw new MoodleError(`Moodle HTTP ${res.status} em ${wsfunction}`);
    }
    const json: unknown = await res.json();
    if (json && typeof json === 'object' && 'exception' in json) {
      const e = json as { errorcode?: string; message?: string };
      throw new MoodleError(
        scrub(`Moodle ${wsfunction}: ${e.message ?? 'erro'}`, ctx.token.reveal()),
        e.errorcode,
      );
    }
    return json as T;
  }

  /** Sobe arquivos para a área de rascunho do aluno (POST multipart a /webservice/upload.php). */
  async upload(
    ctx: MoodleAccess,
    arquivos: { nome: string; bytes: Uint8Array }[],
  ): Promise<{ itemId: string; arquivos: { nome: string; tamanhoBytes: number }[] }> {
    const token = ctx.token.reveal();
    const body = new FormData();
    body.set('token', token);
    body.set('filearea', 'draft');
    body.set('itemid', '0');
    arquivos.forEach((a, i) => body.set(`file_${i + 1}`, new Blob([a.bytes as unknown as ArrayBuffer]), a.nome));

    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/webservice/upload.php`;
    const res = await this.fetchFn(url, { method: 'POST', body });
    if (!res.ok) throw new MoodleError(`Moodle HTTP ${res.status} no upload`);
    const json: unknown = await res.json();

    const erro = Array.isArray(json) ? json.find((i) => i && typeof i === 'object' && ('error' in i || 'exception' in i)) : json;
    if (erro && typeof erro === 'object' && !Array.isArray(erro) && ('error' in erro || 'exception' in erro)) {
      const e = erro as { error?: string; errorcode?: string };
      throw new MoodleError(scrub(`Moodle upload: ${e.error ?? 'erro'}`, token), e.errorcode);
    }
    const itens = Array.isArray(json) ? (json as { filename?: unknown; filesize?: unknown; itemid?: unknown }[]) : [];
    if (itens.length === 0 || itens.some((i) => !i || i.itemid === undefined || i.itemid === null || typeof i.filename !== 'string')) {
      throw new MoodleError('Moodle upload: resposta inesperada');
    }
    return {
      itemId: String(itens[0].itemid),
      arquivos: itens.map((i) => ({ nome: i.filename as string, tamanhoBytes: Number(i.filesize ?? 0) })),
    };
  }
}
