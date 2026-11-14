import type { ClientDirectory } from '../oauth/client-directory';
import { OAuthError, type OAuthService } from '../oauth/oauth.service';
import type { CofreSigaa } from '../sigaa/cofre-sigaa';
import type { ConnectionStatus } from './connection-status';
import { ApiError, requestNotFound, WEB_CLIENT_ID, type RequestInfo, type WebPrincipal } from './web-api';

/** Autorizar um cliente de terceiros (ex.: Claude): ver quem pede, aprovar ou recusar. */
export class AuthorizationRequests {
  constructor(
    private readonly oauth: OAuthService,
    private readonly clients: ClientDirectory,
    private readonly cofre: CofreSigaa,
    private readonly status: ConnectionStatus,
    private readonly now: () => number = Date.now,
  ) {}

  /** Funciona sem sessão (mostra quem pede); com sessão inclui o estado das fontes. */
  async info(id: string, p: WebPrincipal | null): Promise<RequestInfo> {
    const pending = await this.livePending(id);
    if (p && pending.userId && pending.userId !== p.userId) throw requestNotFound();
    const client = await this.clients.get(pending.clientId);
    if (!client) throw requestNotFound();
    return {
      id: pending.id,
      client: this.clients.describe(client, pending.redirectUri),
      signedIn: !!p,
      sources: p ? await this.status.sources(p) : null,
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
    if (!(await this.oauth.claim(pending.id, p.userId))) throw requestNotFound();
    const cred = p.chave ? await this.status.openSigaa(p) : null;
    if (cred) this.cofre.aguardar(pending.id, { login: cred.login, senha: cred.senha });
    try {
      return { redirectTo: await this.oauth.complete(pending.id) };
    } catch (e) {
      this.cofre.descartar(pending.id);
      if (e instanceof OAuthError) throw requestNotFound();
      throw e;
    }
  }

  async deny(id: string, p: WebPrincipal): Promise<{ redirectTo: string }> {
    const pending = await this.livePending(id);
    try {
      return { redirectTo: await this.oauth.denyAs(pending.id, p.userId) };
    } catch (e) {
      if (e instanceof OAuthError) throw requestNotFound();
      throw e;
    }
  }

  private async livePending(id: string) {
    const pending = id ? await this.oauth.findPending(id) : null;
    if (!pending) throw requestNotFound();
    if (pending.expiresAt <= this.now()) {
      throw new ApiError(410, 'request_expired', 'Este pedido expirou. Volte ao app e tente conectar de novo.');
    }
    return pending;
  }
}
