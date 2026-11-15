import type { SecretCipher } from '../ports/secret-cipher';
import type { SyncOutcome } from '../jobs/sync-provider';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import { ReconectarError, type SiasbReader } from './siasb-reader';

export type { SyncOutcome };

export const SYNC_INTERVAL_MS = 45 * 60_000;
export const SYNC_RETRY_MS = 15 * 60_000;
export const SYNC_LEASE_MS = 10 * 60_000;

/**
 * Sincroniza a cópia do SIASB de uma pessoa: trava, lê (snapshot), cifra o primeiro nome do paciente, grava a janela
 * e registra o estado. Só o `claim` pode lançar (falha de infraestrutura); nunca loga mensagem de erro (podem trazer nome
 * de paciente).
 */
export class SiasbSyncer {
  constructor(
    private readonly reader: SiasbReader,
    private readonly copy: SiasbCopyRepository,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async syncUser(userId: string): Promise<SyncOutcome> {
    const start = this.now();
    // Erro de claim (ex.: banco fora) ESCAPA: o job conta como falha e a rota responde 5xx genérico.
    const claimed = await this.copy.claim(userId, start, SYNC_LEASE_MS);
    if (claimed === 'no_account') return 'DISCONNECTED';
    if (claimed === 'busy') return 'BUSY';
    try {
      let outcome: SyncOutcome;
      try {
        const snap = await this.reader.snapshot(userId);
        const disciplines = snap.disciplines.map((d) => ({ id: d.id, name: d.name }));
        const attendances = snap.attendances.map((a) => ({
          id: a.id,
          disciplineId: a.disciplineId,
          disciplineName: a.disciplineName,
          treatmentType: a.treatmentType,
          concluded: a.concluded,
          firstName: this.cipher.encrypt(a.firstName, `siasb-attendance:${userId}:${a.id}`),
        }));
        const sessions = snap.sessions.map((s) => ({
          id: s.id,
          attendanceId: s.attendanceId,
          disciplineId: s.disciplineId,
          disciplineName: s.disciplineName,
          professorName: s.professorName,
          locationName: s.locationName,
          startAt: s.startAt,
          endAt: s.endAt,
          rescheduledStartAt: s.rescheduledStartAt,
          statusLabel: s.statusLabel,
        }));
        const stored = await this.copy.replaceWindow(userId, snap.window, {
          disciplines,
          attendances,
          sessions,
        });
        if (!stored) return 'DISCONNECTED';
        outcome = 'OK';
      } catch (e) {
        outcome = e instanceof ReconectarError ? 'RECONNECT_REQUIRED' : 'UNAVAILABLE';
      }
      const at = this.now();
      const nextRunAt =
        outcome === 'OK'
          ? new Date(at.getTime() + SYNC_INTERVAL_MS)
          : outcome === 'RECONNECT_REQUIRED'
            ? null
            : new Date(at.getTime() + SYNC_RETRY_MS);
      try {
        await this.copy.recordAttempt(userId, {
          result: outcome,
          at,
          nextRunAt,
        });
      } catch {
        // Melhor esforço (ex.: usuário apagado no meio): o resultado da sincronização não muda.
      }
      return outcome;
    } finally {
      try {
        await this.copy.release(userId);
      } catch {
        /* ignorado de propósito */
      }
    }
  }
}
