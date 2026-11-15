import type { SecretCipher } from '../ports/secret-cipher';
import type { SiasbCopyRepository } from '../ports/siasb-copy';

export const STALE_AFTER_MS = 3 * 60 * 60_000;

export interface CalendarItem {
  id: string;
  attendanceId: string;
  disciplineName: string;
  startAt: Date;
  endAt: Date;
  locationName: string;
  professorName: string;
  patientFirstName: string;
  statusLabel: string;
  rescheduledStartAt: Date | null;
}

/**
 * Lê a cópia do SIASB para o painel e o MCP. A consulta é sempre por `userId` (só o dono vê os próprios itens); o
 * primeiro nome do paciente é decifrado com o mesmo AAD do sincronizador. Falha de decifra vira '' (sem lançar, sem log).
 */
export class SiasbCopyReader {
  constructor(
    private readonly copy: SiasbCopyRepository,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async calendar(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<{ syncedAt: Date | null; stale: boolean; items: CalendarItem[] }> {
    const [state, sessions, attendances] = await Promise.all([
      this.copy.state(userId),
      this.copy.sessions(userId, from, to),
      this.copy.attendances(userId),
    ]);
    const names = new Map<string, string>();
    for (const a of attendances) {
      try {
        names.set(a.id, this.cipher.decrypt(a.firstName, `siasb-attendance:${userId}:${a.id}`));
      } catch {
        names.set(a.id, '');
      }
    }
    const syncedAt = state?.lastSuccessAt ?? null;
    const stale =
      !state || state.result !== 'OK' || !syncedAt || this.now().getTime() - syncedAt.getTime() > STALE_AFTER_MS;
    return {
      syncedAt,
      stale,
      items: sessions.map((s) => ({
        id: s.id,
        attendanceId: s.attendanceId,
        disciplineName: s.disciplineName,
        startAt: s.startAt,
        endAt: s.endAt,
        locationName: s.locationName,
        professorName: s.professorName,
        patientFirstName: names.get(s.attendanceId) ?? '',
        statusLabel: s.statusLabel,
        rescheduledStartAt: s.rescheduledStartAt,
      })),
    };
  }
}
