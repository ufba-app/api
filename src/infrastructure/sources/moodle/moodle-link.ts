import type { LinkStatus, MoodleLinkPort } from '../../../application/oauth/oauth-ports';
import type { SourceAccountRepository } from '../../../application/ports/repositories';

export class MoodleLinkUnavailableError extends Error {}

/**
 * Vínculo do Moodle pela tela de /authorize. O SSO pelo servidor (docs/MOODLE.md, Spike 2) AINDA NÃO foi validado
 * contra o AVA real; o Spike 1 (redirect https) foi descartado. Até lá só informa o status; iniciar o vínculo
 * responde com um erro claro, que a tela mostra sem derrubar a autorização. Não existe campo para colar token.
 */
export class MoodleLink implements MoodleLinkPort {
  constructor(private readonly accounts: SourceAccountRepository) {}

  async status(userId: string): Promise<LinkStatus> {
    const accounts = await this.accounts.findByUserAndProvider(userId, 'MOODLE');
    return { connected: accounts.some((a) => a.secret !== null) };
  }

  async startUrl(): Promise<string> {
    throw new MoodleLinkUnavailableError(
      'Conectar o Moodle ainda não está disponível: o login institucional pelo servidor está em validação.',
    );
  }

  async handleReturn(): Promise<void> {
    throw new MoodleLinkUnavailableError('Conectar o Moodle ainda não está disponível.');
  }
}
