import type { Provider } from '../ports/source-gateway';
import type { SourceHealthRepository } from '../ports/source-health';

export const HEALTH_WRITE_THROTTLE_MS = 10 * 60 * 1000;
const MAX_CACHED = 5000;

/**
 * Registra o resultado das leituras ao vivo para a tela Conexões. Só metadados (fonte, conta, estado, motivo fixo,
 * instantes). Throttle: não regrava o mesmo estado e motivo da mesma conta antes de 10 min (cache por processo; com
 * várias instâncias, no pior caso uma escrita por instância a cada 10 min). Nunca lança: falhar em gravar saúde não
 * pode derrubar a leitura da pessoa.
 */
export class SourceHealthRecorder {
  private readonly last = new Map<string, { state: string; reason: string | null; at: number }>();

  constructor(
    private readonly repo: SourceHealthRepository,
    private readonly now: () => number = Date.now,
    private readonly throttleMs: number = HEALTH_WRITE_THROTTLE_MS,
  ) {}

  success(userId: string, provider: Provider, accountKey: string): Promise<void> {
    return this.write(userId, provider, accountKey, 'ok', null, (at) => this.repo.recordSuccess(userId, provider, accountKey, at));
  }

  failure(userId: string, provider: Provider, accountKey: string, reason: string): Promise<void> {
    return this.write(userId, provider, accountKey, 'failing', reason, (at) =>
      this.repo.recordFailure(userId, provider, accountKey, reason, at),
    );
  }

  private async write(
    userId: string,
    provider: Provider,
    accountKey: string,
    state: string,
    reason: string | null,
    persist: (at: Date) => Promise<void>,
  ): Promise<void> {
    const key = `${userId}|${provider}|${accountKey}`;
    const nowMs = this.now();
    const prev = this.last.get(key);
    if (prev && prev.state === state && prev.reason === reason && nowMs - prev.at < this.throttleMs) return;
    if (this.last.size >= MAX_CACHED) this.last.clear();
    this.last.set(key, { state, reason, at: nowMs });
    try {
      await persist(new Date(nowMs));
    } catch {
      this.last.delete(key);
    }
  }
}
