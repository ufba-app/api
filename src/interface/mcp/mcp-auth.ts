import { AUTHENTICATORS, type Authenticator } from '../../application/ports/authenticator';
import { McpAuth, McpPrincipal } from './mcp-ports';

/**
 * Autentica o Bearer do /mcp com os MESMOS autenticadores do REST (`AUTHENTICATORS`: chave de API `plt_` e
 * token de acesso OAuth). Sem Bearer ou com credencial inválida devolve null (o controller responde 401).
 */
export class AuthenticatorsMcpAuth implements McpAuth {
  constructor(private readonly authenticators: readonly Authenticator[]) {}

  async authenticate(header: string | undefined): Promise<McpPrincipal | null> {
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) return null;
    for (const auth of this.authenticators) {
      const found = await auth.authenticate(match[1]);
      if (found) {
        return found.clientId
          ? { userId: found.userId, cliente: { clientId: found.clientId, ...(found.chave ? { chave: found.chave } : {}) } }
          : { userId: found.userId };
      }
    }
    return null;
  }
}

export { AUTHENTICATORS };
