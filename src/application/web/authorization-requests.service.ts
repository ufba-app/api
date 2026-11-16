import type { PermissionsService } from '../permissions/permissions.service';
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
    private readonly permissions: PermissionsService,
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
      permissions: p ? await this.permissions.offered(p.userId) : null,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * Aprovar: a DK do cofre é aberta em memória com a K da sessão e entregue ao cofre para este pedido; no /token o
   * cliente recebe uma K nova e a DK é cifrada com ela (a cópia dele). A pessoa não digita nada.
   *
   * `permissions` (opcional): as permissões POR APP que a pessoa marcou; gravadas para este cliente (o conjunto exato, vazio
   * limpa). Ausente = não mexe no que o app já tem. Validadas ANTES de qualquer efeito (fonte desconectada: 409).
   */
  async approve(id: string, p: WebPrincipal, permissions?: readonly string[]): Promise<{ redirectTo: string }> {
    const pending = await this.livePending(id);
    if (pending.clientId === WEB_CLIENT_ID) throw new ApiError(400, 'invalid_request', 'Pedido inválido.');
    const granted = permissions ? await this.permissions.validate(p.userId, permissions) : null;
    // Dono primeiro (atômico): só depois disso a senha de alguém é aberta.
    if (!(await this.oauth.claim(pending.id, p.userId))) throw requestNotFound();
    const cred = p.chave ? await this.status.openSigaa(p) : null;
    if (cred) this.cofre.aguardar(pending.id, { login: cred.login, dk: cred.dk });
    try {
      const redirectTo = await this.oauth.complete(pending.id);
      if (granted) await this.permissions.grant(p.userId, pending.clientId, granted);
      return { redirectTo };
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
