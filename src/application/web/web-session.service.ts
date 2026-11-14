import type { OAuthStore, UserDirectory } from '../oauth/oauth-ports';
import { OAuthError, type OAuthService } from '../oauth/oauth.service';
import type { CofreSigaa } from '../sigaa/cofre-sigaa';
import type { ConnectionStatus } from './connection-status';
import { ApiError, sessionExpired, WEB_CLIENT_ID, type Me, type WebPrincipal } from './web-api';

/** Sessão do app web: o cliente da casa, entrar, sair, quem está logado e excluir a conta. */
export class WebSessionService {
  constructor(
    private readonly oauth: OAuthService,
    private readonly store: OAuthStore,
    private readonly users: UserDirectory,
    private readonly cofre: CofreSigaa,
    private readonly status: ConnectionStatus,
    /** Origem das telas de login (`AUTH_ORIGIN`, ou o painel). */
    private readonly authOrigin: string,
    private readonly now: () => number = Date.now,
  ) {}

  webRedirectUri(): string {
    return `${this.authOrigin.replace(/\/+$/, '')}/sign-in/callback`;
  }

  /** Cria/atualiza o cliente da casa no boot (redirect_uri segue a `AUTH_ORIGIN`/`WEB_ORIGIN` atual). */
  async ensureWebClient(): Promise<void> {
    await this.store.upsertClient({
      clientId: WEB_CLIENT_ID,
      clientName: 'ufba.app',
      redirectUris: [this.webRedirectUri()],
      createdAt: this.now(),
    });
  }

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
    if (p.chave && (await this.status.sigaaOpens(p))) await this.cofre.apagar({ userId: p.userId, clientId: WEB_CLIENT_ID });
    await this.oauth.revokeToken(token);
  }

  /**
   * Excluir a conta: apaga a pessoa e, em cascata, sessões, tokens, contas conectadas, senhas guardadas e vínculos com
   * as fontes. É o único jeito de trocar o SIGAA ou o AVA ligados à conta.
   */
  async deleteAccount(p: WebPrincipal): Promise<void> {
    await this.users.deleteAccount(p.userId);
  }

  async me(p: WebPrincipal): Promise<Me> {
    const [profile, connections] = await Promise.all([this.users.findProfile(p.userId), this.status.connections(p)]);
    if (!profile) throw sessionExpired();
    return { id: profile.id, email: profile.email, name: profile.name, connections };
  }
}
