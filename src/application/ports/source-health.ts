import type { Provider } from './source-gateway';

/** Estado gravado da leitura de uma conta: só metadados, nunca mensagem da fonte nem segredo. */
export interface SourceHealthRow {
  provider: Provider;
  accountKey: string;
  state: 'ok' | 'failing';
  /** Código fixo (`HealthReason`); nulo quando `ok`. */
  reason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

export abstract class SourceHealthRepository {
  abstract list(userId: string): Promise<SourceHealthRow[]>;
  /** Cria ou atualiza: `state = ok`, `reason = null`, `lastSuccessAt = at`. */
  abstract recordSuccess(userId: string, provider: Provider, accountKey: string, at: Date): Promise<void>;
  /** Cria ou atualiza: `state = failing`, `reason`, `lastFailureAt = at`; não apaga `lastSuccessAt`. */
  abstract recordFailure(userId: string, provider: Provider, accountKey: string, reason: string, at: Date): Promise<void>;
}
