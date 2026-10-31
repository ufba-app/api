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
  private cache = new Map<string, { token: string; expiresAt: number }>();

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

  async accessToken(refreshToken: string): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(refreshToken);
    if (hit && hit.expiresAt - 60_000 > now) return hit.token;

    const res = await (this.opts.fetchFn ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      throw new GoogleApiError(res.status, `Falha ao renovar token do Google (${res.status})`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.cache.set(refreshToken, {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }
}

type Params = Record<string, string | undefined>;

/** GET autenticado, com paginação por pageToken. */
export class GoogleHttp {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async get(refreshToken: string, url: string, params: Params = {}): Promise<Response> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    const token = await this.auth.accessToken(refreshToken);
    const res = await this.fetchFn(u, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new GoogleApiError(res.status, `Google API ${res.status} em ${u.origin}${u.pathname}`);
    }
    return res;
  }

  async getJson<T>(refreshToken: string, url: string, params: Params = {}): Promise<T> {
    return (await (await this.get(refreshToken, url, params)).json()) as T;
  }

  /** Percorre todas as páginas e concatena `listKey`. */
  async list<T>(refreshToken: string, url: string, listKey: string, params: Params = {}): Promise<T[]> {
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
