import {
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
  TokenRecord,
  UserDirectory,
} from './oauth-ports';
import { randomToken, sha256Base64Url, verifyPkceS256 } from './pkce';
import { McpPrincipal } from '../mcp-ports';

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 60 * 60 * 24 * 30;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

/** Erro OAuth no formato RFC 6749 (`error` + `error_description`). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  scope?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export interface TokenParams {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  refresh_token?: string;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** https, ou http só em loopback (clientes CLI como o Claude Code). Sem fragmento. */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
  } catch {
    return false;
  }
}

export class OAuthService {
  constructor(
    private readonly store: OAuthStore,
    private readonly users: UserDirectory,
    private readonly now: () => number = Date.now,
  ) {}

  async registerClient(body: { redirect_uris?: unknown; client_name?: unknown }): Promise<OAuthClient> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && isValidRedirectUri(u))) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris deve listar URLs https (ou http em localhost)');
    }
    const client: OAuthClient = {
      clientId: randomToken(16),
      clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : undefined,
      redirectUris: uris as string[],
      createdAt: this.now(),
    };
    await this.store.saveClient(client);
    return client;
  }

  /** Valida o pedido de /authorize e abre a transação. Erros aqui NÃO redirecionam (cliente/URI não confiáveis). */
  async begin(p: AuthorizeParams): Promise<PendingAuthorization> {
    const client = p.client_id ? await this.store.getClient(p.client_id) : null;
    if (!client) throw new OAuthError('invalid_client', 'client_id desconhecido');
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri não registrado');
    }
    if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'use response_type=code');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'PKCE S256 é obrigatório');
    }
    const pending: PendingAuthorization = {
      id: randomToken(),
      clientId: client.clientId,
      redirectUri: p.redirect_uri,
      state: p.state,
      codeChallenge: p.code_challenge,
      scope: p.scope,
      expiresAt: this.now() + PENDING_TTL_MS,
    };
    await this.store.savePending(pending);
    return pending;
  }

  async pending(id: string | undefined): Promise<PendingAuthorization> {
    const p = id ? await this.store.getPending(id) : null;
    if (!p) throw new OAuthError('invalid_request', 'transação expirada ou inválida; recomece a autorização');
    return p;
  }

  async identify(id: string, email: string): Promise<PendingAuthorization> {
    const p = await this.pending(id);
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new OAuthError('invalid_request', 'e-mail inválido');
    const user = await this.users.findOrCreateByEmail(clean);
    const next = { ...p, userId: user.id };
    await this.store.savePending(next);
    return next;
  }

  /** Emite o authorization code e devolve a URL de retorno ao cliente. */
  async complete(id: string): Promise<string> {
    const p = await this.pending(id);
    if (!p.userId) throw new OAuthError('access_denied', 'usuário não identificado', 403);
    const code = randomToken();
    await this.store.saveCode({
      code,
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      userId: p.userId,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      expiresAt: this.now() + CODE_TTL_MS,
    });
    await this.store.deletePending(id);
    return this.redirectBack(p, { code });
  }

  async deny(id: string): Promise<string> {
    const p = await this.pending(id);
    await this.store.deletePending(id);
    return this.redirectBack(p, { error: 'access_denied' });
  }

  private redirectBack(p: PendingAuthorization, params: Record<string, string>): string {
    const url = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (p.state) url.searchParams.set('state', p.state);
    return url.toString();
  }

  async token(p: TokenParams) {
    if (p.grant_type === 'authorization_code') return this.fromCode(p);
    if (p.grant_type === 'refresh_token') return this.fromRefresh(p);
    throw new OAuthError('unsupported_grant_type', 'use authorization_code ou refresh_token');
  }

  private async fromCode(p: TokenParams) {
    const rec = p.code ? await this.store.takeCode(p.code) : null;
    if (!rec) throw new OAuthError('invalid_grant', 'code inválido, expirado ou já usado');
    if (rec.clientId !== p.client_id || rec.redirectUri !== p.redirect_uri) {
      throw new OAuthError('invalid_grant', 'client_id/redirect_uri não conferem');
    }
    if (!p.code_verifier || !verifyPkceS256(p.code_verifier, rec.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'code_verifier não confere');
    }
    return this.issue(rec.clientId, rec.userId, rec.scope);
  }

  private async fromRefresh(p: TokenParams) {
    const hash = p.refresh_token ? sha256Base64Url(p.refresh_token) : '';
    const rec = hash ? await this.store.getToken(hash) : null;
    if (!rec || rec.kind !== 'refresh' || rec.clientId !== p.client_id) {
      throw new OAuthError('invalid_grant', 'refresh_token inválido ou expirado');
    }
    await this.store.deleteToken(hash); // rotação: cada refresh vale uma vez
    return this.issue(rec.clientId, rec.userId, rec.scope);
  }

  private async issue(clientId: string, userId: string, scope?: string) {
    const access = randomToken();
    const refresh = randomToken();
    const base = { clientId, userId, scope };
    const rec = (kind: TokenRecord['kind'], token: string, ttl: number): TokenRecord => ({
      ...base,
      tokenHash: sha256Base64Url(token),
      kind,
      expiresAt: this.now() + ttl * 1000,
    });
    await this.store.saveToken(rec('access', access, ACCESS_TTL_S));
    await this.store.saveToken(rec('refresh', refresh, REFRESH_TTL_S));
    return {
      access_token: access,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  /** Resolve um access token OAuth; null se não for um (o chamador tenta a chave de API). */
  async verifyAccessToken(token: string): Promise<McpPrincipal | null> {
    const rec = await this.store.getToken(sha256Base64Url(token));
    return rec && rec.kind === 'access' ? { userId: rec.userId } : null;
  }
}
