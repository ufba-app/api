import type { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import { CofreSigaa, CredencialSigaaInvalidaError } from '../sigaa/cofre-sigaa';
import type { ClientDirectory, ClientView } from '../oauth/client-directory';
import {
  LinkError,
  type AppClassroom,
  type ClassroomLinkPort,
  type MoodleLinkPort,
  type OAuthStore,
  type SigaaLinkPort,
  type UserDirectory,
} from '../oauth/oauth-ports';
import { OAuthError, type OAuthService } from '../oauth/oauth.service';
import { randomToken } from '../oauth/pkce';

/** O app web é o cliente OAuth da casa (sem tela de consentimento). */
export const WEB_CLIENT_ID = 'ufba-web';

/** Erro da API do web: `{ error, message }` com o status HTTP. `message` é pt-BR, pronta para mostrar. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const sessionExpired = () => new ApiError(401, 'session_expired', 'Sua sessão expirou. Entre de novo.');

/** Quem chama a API do web: dono da sessão (cookie) com a K da sessão. */
export interface WebPrincipal {
  userId: string;
  clientId: string;
  chave?: Buffer;
}

export type SigaaStatus = 'connected' | 'disconnected' | 'password_required';
export type AccountStatus = 'connected' | 'reconnect_required';
export type GuestApp = 'ufba' | 'guest';

export interface Me {
  id: string;
  email: string | null;
  name: string | null;
  connections: {
    sigaa: { status: SigaaStatus; login: string | null };
    moodle: { status: AccountStatus | 'disconnected'; account: string | null };
    classroom: { available: boolean; apps: GuestApp[]; accounts: { email: string; status: AccountStatus }[] };
  };
}

export interface RequestInfo {
  id: string;
  client: ClientView;
  signedIn: boolean;
  sources: { source: 'sigaa' | 'moodle' | 'classroom'; status: SigaaStatus | AccountStatus | 'disconnected' }[] | null;
  expiresAt: string;
}

export interface AuthorizedApp extends Omit<ClientView, 'redirectUri' | 'metadata'> {
  clientId: string;
  authorizedAt: string;
  lastUsedAt: string | null;
  sigaa: boolean;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const toApp = (a: GuestApp): AppClassroom => (a === 'guest' ? 'convidado' : 'ufba');
const fromApp = (a: AppClassroom): GuestApp => (a === 'convidado' ? 'guest' : 'ufba');
const accountStatus = (a: SourceAccountRecord): AccountStatus => (a.status === 'OK' ? 'connected' : 'reconnect_required');

/**
 * Casos de uso do app web: sessão, conexões, autorização de clientes de terceiros e apps autorizados. Não conhece
 * HTTP; o controller traduz `ApiError` em `{ error, message }`.
 */
export class WebService {
  /** `state` do Google para conectar o Classroom pelo web: aleatório, de uso único, preso à pessoa. */
  private readonly classroomStates = new Map<string, { userId: string; app: AppClassroom; expiresAt: number }>();

  constructor(
    private readonly oauth: OAuthService,
    private readonly store: OAuthStore,
    private readonly users: UserDirectory,
    private readonly clients: ClientDirectory,
    private readonly cofre: CofreSigaa,
    private readonly sigaa: SigaaLinkPort,
    private readonly moodle: MoodleLinkPort,
    private readonly classroom: ClassroomLinkPort,
    private readonly accounts: SourceAccountRepository,
    private readonly cfg: { webOrigin: string },
    private readonly now: () => number = Date.now,
  ) {}

  webOrigin(): string {
    return this.cfg.webOrigin.replace(/\/+$/, '');
  }

  webRedirectUri(): string {
    return `${this.webOrigin()}/sign-in/callback`;
  }

  /** Cria/atualiza o cliente da casa no boot (redirect_uri segue a `WEB_ORIGIN` atual). */
  async ensureWebClient(): Promise<void> {
    await this.store.upsertClient({
      clientId: WEB_CLIENT_ID,
      clientName: 'ufba.app',
      redirectUris: [this.webRedirectUri()],
      createdAt: this.now(),
    });
  }

  // ---- sessão ----

  async createSession(p: { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown }) {
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    try {
      return await this.oauth.createSession(WEB_CLIENT_ID, {
        code: str(p.code),
        codeVerifier: str(p.codeVerifier),
        redirectUri: str(p.redirectUri),
      });
    } catch (e) {
      if (e instanceof OAuthError) {
        throw new ApiError(400, 'invalid_request', 'Não foi possível concluir o login. Tente entrar de novo.');
      }
      throw e;
    }
  }

  /** Sair: apaga a sessão e a senha do SIGAA que só abria com a K dela. */
  async signOut(p: WebPrincipal, token: string): Promise<void> {
    if (p.chave && (await this.sigaaOpens(p))) await this.cofre.apagar({ userId: p.userId, clientId: WEB_CLIENT_ID });
    await this.oauth.revokeToken(token);
  }

  async me(p: WebPrincipal): Promise<Me> {
    const [profile, sigaa, moodle, classroom] = await Promise.all([
      this.users.findProfile(p.userId),
      this.sigaaStatus(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
    ]);
    if (!profile) throw sessionExpired();
    const m = moodle[0];
    return {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      connections: {
        sigaa,
        moodle: m ? { status: accountStatus(m), account: m.accountKey } : { status: 'disconnected', account: null },
        classroom: {
          available: this.classroom.enabled(),
          apps: this.classroom.apps().map(fromApp),
          accounts: classroom.map((a) => ({ email: a.accountKey, status: accountStatus(a) })),
        },
      },
    };
  }

  // ---- SIGAA ----

  async connectSigaa(p: WebPrincipal, body: { login?: unknown; password?: unknown }): Promise<void> {
    if (!p.chave) throw sessionExpired();
    const login = typeof body.login === 'string' ? body.login : '';
    const password = typeof body.password === 'string' ? body.password : '';
    let usuario: string;
    try {
      usuario = await this.sigaa.validar(`web:${p.userId}`, login, password, p.userId);
    } catch (e) {
      throw linkToApi(e);
    }
    await this.cofre.gravar({ userId: p.userId, clientId: WEB_CLIENT_ID }, { login: usuario, senha: password }, p.chave);
  }

  async disconnectSigaa(p: WebPrincipal): Promise<void> {
    await this.cofre.apagar({ userId: p.userId, clientId: WEB_CLIENT_ID });
  }

  // ---- Moodle ----

  async moodleStart(p: WebPrincipal): Promise<{ launchUrl: string; scheme: string }> {
    return { launchUrl: await this.moodle.launchUrl(p.userId, 'web'), scheme: this.moodle.scheme() };
  }

  async connectMoodle(p: WebPrincipal, body: { link?: unknown }): Promise<void> {
    try {
      await this.moodle.connect(p.userId, 'web', typeof body.link === 'string' ? body.link : '');
    } catch (e) {
      throw linkToApi(e);
    }
  }

  async disconnectMoodle(p: WebPrincipal): Promise<void> {
    for (const a of await this.accounts.findByUserAndProvider(p.userId, 'MOODLE')) await this.accounts.delete(a.id);
  }

  // ---- Classroom ----

  /** URL do Google para conectar uma conta; `callbackBase` = URL pública da API. */
  async classroomStart(p: WebPrincipal, app: unknown, callbackBase: string): Promise<string> {
    const qual: GuestApp = app === 'guest' ? 'guest' : 'ufba';
    const interno = toApp(qual);
    if (!this.classroom.apps().includes(interno)) {
      throw new ApiError(501, 'not_supported', 'Esse tipo de conta do Classroom não está disponível neste servidor.');
    }
    this.pruneStates();
    const state = `web.${randomToken()}`;
    this.classroomStates.set(state, { userId: p.userId, app: interno, expiresAt: this.now() + STATE_TTL_MS });
    return this.classroom.startUrl(interno, classroomCallback(callbackBase, interno), state);
  }

  isWebState(state: unknown): state is string {
    return typeof state === 'string' && state.startsWith('web.');
  }

  /**
   * Volta do Google (Classroom pelo web). O `state` precisa ser desta pessoa E o cookie de sessão da mesma pessoa
   * (senão alguém poderia ligar a conta dele na sessão de outro). Devolve para onde mandar o navegador.
   */
  async classroomCallback(
    q: { state: string; code?: string; error?: string },
    sessionUserId: string | undefined,
    callbackBase: string,
  ): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.webOrigin()}/connections?${new URLSearchParams(params).toString()}`;
    this.pruneStates();
    const st = this.classroomStates.get(q.state);
    this.classroomStates.delete(q.state);
    if (!st || !sessionUserId || st.userId !== sessionUserId) {
      return back({ error: 'invalid_request', message: 'O pedido de conexão expirou. Tente de novo.' });
    }
    if (q.error || !q.code) {
      return back({ error: 'access_denied', message: 'Conexão com o Classroom cancelada na tela do Google.' });
    }
    try {
      await this.classroom.handleCallback(st.app, st.userId, q.code, classroomCallback(callbackBase, st.app));
      return back({ connected: 'classroom' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao conectar o Classroom.';
      return back({ error: 'source_unavailable', message: msg });
    }
  }

  async disconnectClassroom(p: WebPrincipal, email: string): Promise<void> {
    const alvo = email.trim().toLowerCase();
    const contas = (await this.accounts.findByUserAndProvider(p.userId, 'CLASSROOM')).filter(
      (a) => a.accountKey.toLowerCase() === alvo,
    );
    if (contas.length === 0) throw new ApiError(404, 'not_found', 'Essa conta do Classroom não está conectada.');
    for (const a of contas) await this.accounts.delete(a.id);
  }

  // ---- autorizar cliente de terceiros ----

  /** Funciona sem sessão (mostra quem pede); com sessão inclui o estado das fontes. */
  async requestInfo(id: string, p: WebPrincipal | null): Promise<RequestInfo> {
    const pending = await this.livePending(id);
    if (p && pending.userId && pending.userId !== p.userId) throw notFound();
    const client = await this.clients.get(pending.clientId);
    if (!client) throw new ApiError(404, 'request_not_found', 'Pedido de autorização não encontrado.');
    return {
      id: pending.id,
      client: this.clients.describe(client, pending.redirectUri),
      signedIn: !!p,
      sources: p ? await this.sources(p) : null,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * Aprovar: a senha do SIGAA da sessão é aberta em memória e entregue ao cofre para este pedido; no /token o cliente
   * recebe uma K nova e a senha é cifrada de novo com ela. A pessoa não digita nada.
   */
  async approve(id: string, p: WebPrincipal): Promise<{ redirectTo: string }> {
    const pending = await this.livePending(id);
    if (pending.clientId === WEB_CLIENT_ID) throw new ApiError(400, 'invalid_request', 'Pedido inválido.');
    // Dono primeiro (atômico): só depois disso a senha de alguém é aberta.
    if (!(await this.oauth.claim(pending.id, p.userId))) throw notFound();
    const cred = p.chave ? await this.openSigaa(p) : null;
    if (cred) this.cofre.aguardar(pending.id, { login: cred.login, senha: cred.senha });
    try {
      return { redirectTo: await this.oauth.complete(pending.id) };
    } catch (e) {
      this.cofre.descartar(pending.id);
      if (e instanceof OAuthError) throw notFound();
      throw e;
    }
  }

  async deny(id: string, p: WebPrincipal): Promise<{ redirectTo: string }> {
    const pending = await this.livePending(id);
    try {
      return { redirectTo: await this.oauth.denyAs(pending.id, p.userId) };
    } catch (e) {
      if (e instanceof OAuthError) throw notFound();
      throw e;
    }
  }

  // ---- apps autorizados ----

  async authorizedApps(p: WebPrincipal): Promise<{ apps: AuthorizedApp[] }> {
    const tokens = (await this.store.listTokens(p.userId)).filter((t) => t.clientId !== WEB_CLIENT_ID);
    const byClient = new Map<string, { first: number; last: number }>();
    for (const t of tokens) {
      const cur = byClient.get(t.clientId) ?? { first: Infinity, last: 0 };
      cur.first = Math.min(cur.first, t.createdAt ?? this.now());
      cur.last = Math.max(cur.last, t.lastUsedAt ?? 0);
      byClient.set(t.clientId, cur);
    }
    const apps: AuthorizedApp[] = [];
    for (const [clientId, use] of byClient) {
      const client = await this.store.getClient(clientId);
      if (!client || client.redirectUris.length === 0) continue;
      const { redirectUri: _r, metadata: _m, ...view } = this.clients.describe(client, client.redirectUris[0]);
      // Cliente com redirect_uris em domínios diferentes (ex.: claude.ai + outro): não dá para saber por qual foi
      // aprovado, então não herda nome/selo de nenhum deles.
      const hosts = [...new Set(client.redirectUris.map((u) => new URL(u).hostname))];
      if (hosts.length > 1) Object.assign(view, { domain: hosts.join(', '), name: null, logoUrl: null, verified: false });
      const sigaa = await this.cofre.situacao({ userId: p.userId, clientId });
      apps.push({
        clientId,
        ...view,
        authorizedAt: new Date(use.first).toISOString(),
        lastUsedAt: use.last ? new Date(use.last).toISOString() : null,
        sigaa: !!sigaa,
      });
    }
    apps.sort((a, b) => (b.lastUsedAt ?? b.authorizedAt).localeCompare(a.lastUsedAt ?? a.authorizedAt));
    return { apps };
  }

  async revokeApp(p: WebPrincipal, clientId: string): Promise<void> {
    if (clientId === WEB_CLIENT_ID) throw new ApiError(400, 'invalid_request', 'Use "Sair" para encerrar esta sessão.');
    const has = (await this.store.listTokens(p.userId)).some((t) => t.clientId === clientId);
    if (!has) throw new ApiError(404, 'not_found', 'Esse app não tem acesso.');
    await this.store.deleteTokensOfClient(p.userId, clientId);
    await this.cofre.apagar({ userId: p.userId, clientId });
  }

  // ---- auxiliares ----

  private async livePending(id: string) {
    const pending = id ? await this.oauth.findPending(id) : null;
    if (!pending) throw new ApiError(404, 'request_not_found', 'Pedido de autorização não encontrado.');
    if (pending.expiresAt <= this.now()) {
      throw new ApiError(410, 'request_expired', 'Este pedido expirou. Volte ao app e tente conectar de novo.');
    }
    return pending;
  }

  private async sources(p: WebPrincipal): Promise<NonNullable<RequestInfo['sources']>> {
    const [sigaa, moodle, classroom] = await Promise.all([
      this.sigaaStatus(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
    ]);
    const agg = (list: SourceAccountRecord[]) =>
      list.length === 0 ? 'disconnected' : list.some((a) => a.status === 'OK') ? 'connected' : 'reconnect_required';
    const out: NonNullable<RequestInfo['sources']> = [
      { source: 'sigaa', status: sigaa.status },
      { source: 'moodle', status: agg(moodle) },
    ];
    if (this.classroom.enabled()) out.push({ source: 'classroom', status: agg(classroom) });
    return out;
  }

  private async sigaaStatus(p: WebPrincipal): Promise<Me['connections']['sigaa']> {
    const rec = await this.cofre.situacao({ userId: p.userId, clientId: WEB_CLIENT_ID });
    if (!rec) return { status: 'disconnected', login: null };
    if (rec.status !== 'OK' || !(await this.sigaaOpens(p))) return { status: 'password_required', login: rec.login };
    return { status: 'connected', login: rec.login };
  }

  private async sigaaOpens(p: WebPrincipal): Promise<boolean> {
    return (await this.openSigaa(p)) !== null;
  }

  private async openSigaa(p: WebPrincipal) {
    if (!p.chave) return null;
    try {
      return await this.cofre.abrir({ userId: p.userId, clientId: WEB_CLIENT_ID }, p.chave);
    } catch (e) {
      if (e instanceof CredencialSigaaInvalidaError) return null;
      throw e;
    }
  }

  private async accountsOf(userId: string, provider: 'MOODLE' | 'CLASSROOM') {
    return (await this.accounts.findByUserAndProvider(userId, provider)).filter((a) => a.secret !== null);
  }

  private pruneStates(): void {
    const t = this.now();
    for (const [k, v] of this.classroomStates) if (v.expiresAt <= t) this.classroomStates.delete(k);
  }
}

const notFound = () => new ApiError(404, 'request_not_found', 'Pedido de autorização não encontrado.');

function classroomCallback(base: string, app: AppClassroom): string {
  return `${base.replace(/\/+$/, '')}/oauth/callback/${app === 'ufba' ? 'google' : 'classroom'}`;
}

const LINK_STATUS: Record<LinkError['code'], number> = {
  invalid_request: 400,
  invalid_credentials: 422,
  too_many_attempts: 429,
  source_unavailable: 502,
};

function linkToApi(e: unknown): unknown {
  if (e instanceof LinkError) return new ApiError(LINK_STATUS[e.code], e.code, e.message);
  return e;
}
