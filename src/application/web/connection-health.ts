import { STALE_AFTER_MS } from '../siasb/siasb-copy-reader';
import type { SyncResult } from '../ports/siasb-copy';
import type { SourceHealthRow } from '../ports/source-health';
import type { Health, HealthAction, HealthReason, HealthState } from './contract';

/** Quanto antes do fim estimado a sessão do SIASB vira "deve vencer em breve". */
export const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const make = (state: HealthState, reason: HealthReason | null, message: string, action: HealthAction | null, since: Date | null): Health => ({
  state,
  reason,
  message,
  action,
  since: iso(since),
});

const ok = (since: Date | null): Health => make('ok', null, 'Funcionando.', null, since);

/**
 * Mensagens fixas por motivo: nada do que a fonte respondeu entra aqui (a saúde nunca ecoa texto de fora).
 * `fonte` é o nome da fonte para a pessoa.
 */
const unavailable = (fonte: string, since: Date | null): Health =>
  make('degraded', 'source_unavailable', `${fonte} está fora do ar agora. Tentamos de novo na próxima leitura.`, 'retry', since);
const neverRead = (): Health => make('unknown', 'never_read', 'Ainda não lemos esta conexão.', null, null);

/** Saúde de leitura (SIGAA, Moodle, Classroom) a partir do que `source_health` guardou para a conta. */
export function fromRecord(fonte: string, rec: SourceHealthRow | undefined): Health {
  if (!rec) return neverRead();
  if (rec.state === 'failing') return unavailable(fonte, rec.lastFailureAt);
  return ok(rec.lastSuccessAt);
}

export const findRecord = (rows: SourceHealthRow[], provider: SourceHealthRow['provider'], accountKey: string) =>
  rows.find((r) => r.provider === provider && r.accountKey === accountKey);

export function sigaaHealth(status: 'connected' | 'disconnected' | 'password_required' | 'locked', rec: SourceHealthRow | undefined): Health | null {
  if (status === 'disconnected') return null;
  if (status === 'password_required') {
    return make('action_required', 'password_required', 'Digite a senha do SIGAA de novo para continuar.', 'reconnect', null);
  }
  if (status === 'locked') {
    return make('action_required', 'locked', 'Toque na passkey para liberar o SIGAA nesta sessão.', 'unlock', null);
  }
  return fromRecord('O SIGAA', rec);
}

export function accountHealth(fonte: string, status: 'connected' | 'reconnect_required', rec: SourceHealthRow | undefined): Health {
  if (status === 'reconnect_required') {
    return make('action_required', 'token_revoked', `Reconecte o ${fonte}: o acesso foi recusado ou expirou.`, 'reconnect', null);
  }
  return fromRecord(`O ${fonte}`, rec);
}

export function siasbHealth(i: {
  status: 'connected' | 'reconnect_required' | 'disconnected';
  expiresAt: Date | null;
  syncedAt: Date | null;
  syncResult: SyncResult | null;
  now: number;
}): Health | null {
  if (i.status === 'disconnected') return null;
  if (i.status === 'reconnect_required' || i.syncResult === 'RECONNECT_REQUIRED') {
    return make('action_required', 'session_expired', 'A sessão do SIASB venceu. Conecte de novo.', 'reconnect', i.syncedAt);
  }
  if (i.syncResult === 'UNAVAILABLE') return unavailable('O SIASB', i.syncedAt);
  if (i.syncedAt && i.now - i.syncedAt.getTime() > STALE_AFTER_MS) {
    const hours = Math.floor((i.now - i.syncedAt.getTime()) / (60 * 60 * 1000));
    return make('degraded', 'stale_copy', `Os dados do SIASB são de ${hours} h atrás.`, null, i.syncedAt);
  }
  if (i.expiresAt && i.expiresAt.getTime() - i.now <= EXPIRING_SOON_MS) {
    return make('degraded', 'expiring_soon', 'A sessão do SIASB deve vencer em breve. Conecte de novo para renovar.', 'reconnect', i.syncedAt);
  }
  if (!i.syncedAt) return neverRead();
  return ok(i.syncedAt);
}
