import type { PermissionsService } from '../permissions/permissions.service';
import type { ClientDirectory } from '../oauth/client-directory';
import { isLocalRedirect } from '../oauth/redirect-uri';
import type { OAuthStore } from '../oauth/oauth-ports';
import type { CofreSigaa } from '../sigaa/cofre-sigaa';
import { ApiError, WEB_CLIENT_ID, type AuthorizedApp, type WebPrincipal } from './web-api';

/** Apps que a pessoa autorizou: listar e revogar. */
export class AuthorizedApps {
  constructor(
    private readonly store: OAuthStore,
    private readonly clients: ClientDirectory,
    private readonly cofre: CofreSigaa,
    private readonly permissions: PermissionsService,
    private readonly now: () => number = Date.now,
  ) {}

  async list(p: WebPrincipal): Promise<{ apps: AuthorizedApp[] }> {
    const tokens = (await this.store.listTokens(p.userId)).filter((t) => t.clientId !== WEB_CLIENT_ID);
    const byClient = new Map<string, { first: number; last: number }>();
    for (const t of tokens) {
      const cur = byClient.get(t.clientId) ?? { first: Infinity, last: 0 };
      cur.first = Math.min(cur.first, t.createdAt ?? this.now());
      cur.last = Math.max(cur.last, t.lastUsedAt ?? 0);
      byClient.set(t.clientId, cur);
    }
    const apps: AuthorizedApp[] = [];
    const granted = await this.permissions.grantedTo(p.userId);
    for (const [clientId, use] of byClient) {
      const client = await this.store.getClient(clientId);
      if (!client || client.redirectUris.length === 0) continue;
      const { redirectUri: _r, metadata: _m, ...view } = this.clients.describe(client, client.redirectUris[0]);
      // Cliente com redirect_uris em domínios diferentes (ex.: claude.ai + outro): não dá para saber por qual foi
      // aprovado, então não herda nome/selo de nenhum deles.
      const hosts = [...new Set(client.redirectUris.map((u) => new URL(u).hostname))];
      // (Exceto cliente CIMD verificado pelo host do documento: a identidade vem do client_id, não dos redirects.)
      const local = client.redirectUris.every(isLocalRedirect);
      Object.assign(view, { local });
      if (hosts.length > 1 && !this.clients.verifiedByClientId(client)) Object.assign(view, { domain: hosts.join(', '), name: null, logoUrl: null, verified: false });
      const sigaa = await this.cofre.situacao({ userId: p.userId, clientId });
      apps.push({
        clientId,
        ...view,
        authorizedAt: new Date(use.first).toISOString(),
        lastUsedAt: use.last ? new Date(use.last).toISOString() : null,
        sigaa: !!sigaa,
        permissions: granted.get(clientId) ?? [],
      });
    }
    apps.sort((a, b) => (b.lastUsedAt ?? b.authorizedAt).localeCompare(a.lastUsedAt ?? a.authorizedAt));
    return { apps };
  }

  async revoke(p: WebPrincipal, clientId: string): Promise<void> {
    if (clientId === WEB_CLIENT_ID) throw new ApiError(400, 'invalid_request', 'Use "Sair" para encerrar esta sessão.');
    const has = (await this.store.listTokens(p.userId)).some((t) => t.clientId === clientId);
    if (!has) throw new ApiError(404, 'not_found', 'Esse app não tem acesso.');
    await this.store.deleteTokensOfClient(p.userId, clientId);
    await this.cofre.apagar({ userId: p.userId, clientId });
    await this.permissions.appRevoked(p.userId, clientId);
  }

  /** Retira UMA permissão de UM app, sem revogar o app. */
  async revokePermission(p: WebPrincipal, clientId: string, key: string): Promise<void> {
    if (clientId === WEB_CLIENT_ID) throw new ApiError(400, 'invalid_request', 'Pedido inválido.');
    await this.permissions.revoke(p.userId, clientId, key);
  }
}
