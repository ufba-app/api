import type { SyncProvider } from '../jobs/sync-provider';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import type { SiasbSyncer } from './siasb-syncer';

export const SYNC_MAX_USERS_PER_RUN = 200;
export const SYNC_SPACING_MS = 1500;
/** Depois de tantos `UNAVAILABLE` seguidos o SIASB está fora do ar: a rodada para (a próxima tenta de novo). */
export const SYNC_MAX_CONSECUTIVE_UNAVAILABLE = 3;

/** O SIASB como fonte do cron genérico de sincronização. */
export class SiasbSyncProvider implements SyncProvider {
  readonly key = 'siasb';
  readonly maxUsersPerRun = SYNC_MAX_USERS_PER_RUN;
  readonly spacingMs = SYNC_SPACING_MS;
  readonly maxConsecutiveUnavailable = SYNC_MAX_CONSECUTIVE_UNAVAILABLE;

  constructor(
    private readonly syncer: Pick<SiasbSyncer, 'syncUser'>,
    private readonly copy: Pick<SiasbCopyRepository, 'dueUsers'>,
  ) {}

  dueUsers(now: Date, limit: number): Promise<string[]> {
    return this.copy.dueUsers(now, limit);
  }

  syncUser(userId: string) {
    return this.syncer.syncUser(userId);
  }
}
