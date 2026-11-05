import type { SigaaLinkPort } from '../../../application/oauth/oauth-ports';
import type { CofreSigaa } from '../../../application/sigaa/cofre-sigaa';
import { createSigaaHttpClient, type SigaaHttpClient } from './http-client';
import { SigaaInvalidCredentialsError, SigaaSession } from './session';

export class SigaaLinkError extends Error {}

const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

/**
 * Vínculo do SIGAA na tela de /authorize: valida login e senha com 1 login real + 1 GET do portal e, se passar,
 * entrega ao cofre (memória, com TTL) até o /token. A senha nunca entra em mensagem de erro nem em log.
 */
export class SigaaLink implements SigaaLinkPort {
  constructor(
    private readonly cofre: CofreSigaa,
    private readonly http: SigaaHttpClient = createSigaaHttpClient(),
  ) {}

  async conectar(txn: string, login: string, senha: string): Promise<void> {
    const usuario = login.trim();
    if (!usuario || !senha) throw new SigaaLinkError('Informe o usuário e a senha do SIGAA.');
    try {
      const session = new SigaaSession(this.http);
      await session.login({ login: usuario, password: senha });
      await session.get(PORTAL_HOME_PATH);
    } catch (e) {
      if (e instanceof SigaaInvalidCredentialsError) {
        throw new SigaaLinkError('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
      }
      throw new SigaaLinkError('Não consegui falar com o SIGAA agora. Tente de novo em instantes.');
    }
    this.cofre.aguardar(txn, { login: usuario, senha });
  }

  pendente(txn: string): boolean {
    return this.cofre.temPendente(txn);
  }
}
