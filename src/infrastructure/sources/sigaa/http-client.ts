export const SIGAA_BASE_URL = 'https://sigaa.ufba.br';

export interface SigaaHttpRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, string>;
  cookie?: string;
  /** Página de onde o POST partiu (cabeçalho Referer). Ausente: o próprio `path`. */
  referer?: string;
}

export interface SigaaHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Corpo decodificado como ISO-8859-1. */
  body: string;
  /** Bytes crus, para recursos binários (PDF) que a decodificação de texto corromperia. */
  bodyBuffer?: Buffer;
}

export interface SigaaHttpClient {
  request(req: SigaaHttpRequest): Promise<SigaaHttpResponse>;
}

export class SigaaRateLimitedError extends Error {
  constructor() {
    super('SIGAA respondeu 429 (limite de requisições)');
    this.name = 'SigaaRateLimitedError';
  }
}

/**
 * O fetch do Node se anuncia como `node`; essa é a assinatura mais fácil de barrar na borda, e o
 * SIGAA devolve então a página de login (lida como senha errada). São os mesmos cabeçalhos que o
 * formulário de login que preenchemos enviaria.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

export function decodeIso88591(bytes: Uint8Array): string {
  // Cada byte vira o code point igual (latin1), sem depender de iconv.
  return Buffer.from(bytes).toString('latin1');
}

export function encodeFormBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value);
  return params.toString();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cliente HTTP real: fetch simples, sem cookie jar (a sessão passa o cookie a cada requisição),
 * `redirect: 'manual'`. Uma nova tentativa com espera em falha de rede ou 429.
 * Não loga corpo nem cabeçalhos: o corpo do login carrega a senha.
 */
export function createSigaaHttpClient(
  baseUrl: string = SIGAA_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): SigaaHttpClient {
  async function once(req: SigaaHttpRequest): Promise<SigaaHttpResponse> {
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    if (req.cookie) headers['Cookie'] = req.cookie;
    if (req.body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Origin'] = baseUrl;
      headers['Referer'] = `${baseUrl}${req.referer ?? req.path}`;
    }
    const response = await fetchImpl(`${baseUrl}${req.path}`, {
      method: req.method,
      headers,
      body: req.body ? encodeFormBody(req.body) : undefined,
      redirect: 'manual',
    });
    if (response.status === 429) throw new SigaaRateLimitedError();
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: {
        location: response.headers.get('location') ?? '',
        'set-cookie': response.headers.get('set-cookie') ?? '',
        'content-type': response.headers.get('content-type') ?? '',
      },
      body: decodeIso88591(bytes),
      bodyBuffer: bytes,
    };
  }

  return {
    async request(req) {
      try {
        return await once(req);
      } catch {
        await sleep(1000);
        return once(req);
      }
    },
  };
}
