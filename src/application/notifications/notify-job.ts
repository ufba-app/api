import type { AlertProvider, AlertResult } from './alert-provider';

export interface NotifyJobDeps {
  providers: readonly AlertProvider[];
  now?: () => Date;
}

const empty = (): AlertResult => ({ sent: 0, suppressed: 0, skipped: 0, failed: 0 });
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Uma execução do `notify-cron`: percorre `ALERT_PROVIDERS`, e para cada um avalia as pessoas de `usersToEvaluate()`.
 * Erro de um provedor não derruba os outros e erro numa pessoa não derruba as demais (conta como falha). Loga só
 * contagens, uma linha por provedor: nunca id de pessoa, endpoint nem texto de aviso. O job só lê o banco e envia pelo
 * `Notifier`. Saída: 0 se rodou (mesmo com falhas por pessoa e sem provedor nenhum); 1 se não deu para listar as pessoas
 * de NENHUM dos provedores existentes.
 */
export async function runNotifyJob(deps: NotifyJobDeps, log: (line: string) => void = console.log): Promise<0 | 1> {
  const now = deps.now ?? (() => new Date());
  if (deps.providers.length === 0) {
    log('notify: nenhum provedor de avisos registrado');
    return 0;
  }
  let listed = 0;
  for (const provider of deps.providers) {
    let users: string[];
    try {
      users = await provider.usersToEvaluate();
    } catch {
      log(`notify[${provider.key}]: não foi possível listar quem avaliar`);
      continue;
    }
    listed++;
    const total = empty();
    for (const userId of users) {
      try {
        const r = await provider.evaluateUser(userId, now());
        total.sent += count(r?.sent);
        total.suppressed += count(r?.suppressed);
        total.skipped += count(r?.skipped);
        total.failed += count(r?.failed);
      } catch {
        total.failed++;
      }
    }
    log(`notify[${provider.key}]: ${users.length} pessoas, ${total.sent} enviados, ${total.suppressed} suprimidos, ${total.skipped} pulados, ${total.failed} falhas`);
  }
  return listed === 0 ? 1 : 0;
}
