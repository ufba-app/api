export type SyncOutcome = 'OK' | 'RECONNECT_REQUIRED' | 'UNAVAILABLE' | 'BUSY' | 'DISCONNECTED';

/**
 * Contrato de uma fonte sincronizada pelo cron genérico (`runSyncJob`).
 * Cada provedor traz os próprios limites; o runner não conhece nenhuma fonte.
 */
export interface SyncProvider {
  /** Nome curto e fixo da fonte, usado no log (ex.: 'siasb'). */
  readonly key: string;
  readonly maxUsersPerRun: number;
  readonly spacingMs: number;
  /** Depois de tantos `UNAVAILABLE` seguidos, a rodada deste provedor para. */
  readonly maxConsecutiveUnavailable: number;
  dueUsers(now: Date, limit: number): Promise<string[]>;
  syncUser(userId: string): Promise<SyncOutcome>;
}

/** Token de injeção: `SyncProvider[]`. */
export const SYNC_PROVIDERS = Symbol('SYNC_PROVIDERS');
