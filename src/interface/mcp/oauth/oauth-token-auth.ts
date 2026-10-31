import { McpAuth, McpPrincipal } from '../mcp-ports';
import { OAuthService } from './oauth.service';

/**
 * Autenticação do /mcp: access token OAuth do serviço primeiro; senão cai na chave de API estática
 * (atalho para scripts e `claude mcp add --header`).
 */
export class OAuthOrApiKeyAuth implements McpAuth {
  constructor(
    private readonly oauth: OAuthService,
    private readonly apiKeyAuth: McpAuth,
  ) {}

  async authenticate(header: string | undefined): Promise<McpPrincipal | null> {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!match) return null;
    return (await this.oauth.verifyAccessToken(match[1])) ?? this.apiKeyAuth.authenticate(header);
  }
}
