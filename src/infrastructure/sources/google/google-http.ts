import { createHash } from 'node:crypto';
import { Secret } from '../../../application/shared/secret';
export type FetchFn = typeof fetch;

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Troca refresh token por access token (cache em memória até perto de expirar). Nunca loga tokens. */
export class GoogleAuth {
  // Chave do cache: hash do refresh token (o token em claro não fica como chave de Map, que aparece se alguém logar o objeto).
  private cache = new Map<string, { token: Secret; expiresAt: number }>();

  constructor(
    private readonly opts: {
      clientId: string;
      clientSecret: string;
      fetchFn?: FetchFn;
      now?: () => number;
    },
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchFn): GoogleAuth {
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não definidos');
    }
    return new GoogleAuth({ clientId, clientSecret, fetchFn });
  }

  async accessToken(refreshToken: Secret): Promise<Secret> {
    const now = (this.opts.now ?? Date.now)();
    const key = createHash('sha256').update(refreshToken.reveal()).digest('base64url');
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - 60_000 > now) return hit.token;

    const res = await (this.opts.fetchFn ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: refreshToken.reveal(),
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      throw new GoogleApiError(res.status, `Falha ao renovar token do Google (${res.status})`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const token = Secret.of(json.access_token);
    this.cache.set(key, {
      token,
      expiresAt: now + (json.expires_in ?? 3600) * 1000,
    });
    return token;
  }
}

type Params = Record<string, string | undefined>;

/** GET autenticado, com paginação por pageToken. */
export class GoogleHttp {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async get(refreshToken: Secret, url: string, params: Params = {}): Promise<Response> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    const token = await this.auth.accessToken(refreshToken);
    const res = await this.fetchFn(u, { headers: { authorization: `Bearer ${token.reveal()}` } });
    if (!res.ok) {
      throw new GoogleApiError(res.status, `Google API ${res.status} em ${u.origin}${u.pathname}`);
    }
    return res;
  }

  async getJson<T>(refreshToken: Secret, url: string, params: Params = {}): Promise<T> {
    return (await (await this.get(refreshToken, url, params)).json()) as T;
  }

  /** Percorre todas as páginas e concatena `listKey`. */
  async list<T>(refreshToken: Secret, url: string, listKey: string, params: Params = {}): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.getJson<Record<string, unknown>>(refreshToken, url, { ...params, pageToken });
      out.push(...((page[listKey] as T[] | undefined) ?? []));
      pageToken = page.nextPageToken as string | undefined;
    } while (pageToken);
    return out;
  }
}
