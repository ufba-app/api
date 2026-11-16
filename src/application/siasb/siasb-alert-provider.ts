import type { AlertProvider, AlertResult } from '../notifications/alert-provider';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import type { SiasbAlerts } from './siasb-alerts';

/**
 * Fonte SIASB do `notify-cron`: avalia todas as pessoas com conta SIASB (qualquer estado, para o aviso de reconexão
 * vencida continuar). Nunca lança: uma exceção vira `failed: 1`, sem registrar a mensagem.
 */
export class SiasbAlertProvider implements AlertProvider {
  readonly key = 'siasb';

  constructor(
    private readonly copy: Pick<SiasbCopyRepository, 'connectedUsers'>,
    private readonly alerts: Pick<SiasbAlerts, 'evaluateUser'>,
  ) {}

  usersToEvaluate(): Promise<string[]> {
    return this.copy.connectedUsers();
  }

  async evaluateUser(userId: string, now: Date): Promise<AlertResult> {
    try {
      return await this.alerts.evaluateUser(userId, now);
    } catch {
      return { sent: 0, suppressed: 0, skipped: 0, failed: 1 };
    }
  }
}
