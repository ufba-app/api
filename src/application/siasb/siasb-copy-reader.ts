import type { ClinicalSession } from '../../domain/siasb/types';
import type { AcademicCalendar } from '../ports/academic-calendar';
import type { SecretCipher } from '../ports/secret-cipher';
import type { SiasbCopyRepository, SyncState } from '../ports/siasb-copy';

import { DAY_MS, MAX_AHEAD_DAYS } from './session-period';
import { computePreviousSlot, computeSituation, historyWindow, type DisciplineSituation } from './situation';

export type PreviousSlot = { slot: Date; deadline: Date; covered: boolean };

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
    private readonly academicCalendar: AcademicCalendar,
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
    const { syncedAt, stale } = this.freshness(state);
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

  /** Situação de cada disciplina a partir da cópia (mesma regra do leitor ao vivo; sessões de [agora − 60 d, agora + 45 d]). */
  async situation(userId: string): Promise<{
    syncedAt: Date | null;
    stale: boolean;
    items: DisciplineSituation[];
    /** Por disciplina: o último horário da clínica cujo prazo já passou (base do "Prazo perdido"). */
    previous: Record<string, PreviousSlot | null>;
  }> {
    const now = this.now();
    const [from, to] = historyWindow(now);
    const [state, disciplines, attendances, sessions, holidays] = await Promise.all([
      this.copy.state(userId),
      this.copy.disciplines(userId),
      this.copy.attendances(userId),
      this.copy.sessions(userId, from, to),
      this.academicCalendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS)),
    ]);
    const clinicalSessions: ClinicalSession[] = sessions.map((s) => ({
      id: s.id,
      attendanceId: s.attendanceId,
      disciplineId: s.disciplineId,
      disciplineName: s.disciplineName,
      firstName: '',
      professorName: s.professorName,
      locationName: s.locationName,
      startAt: s.startAt,
      endAt: s.endAt,
      rescheduledStartAt: s.rescheduledStartAt,
      statusLabel: s.statusLabel,
    }));
    const items = computeSituation({
      disciplines,
      activeAttendances: attendances
        .filter((a) => a.active)
        .map((a) => ({
          id: a.id,
          disciplineId: a.disciplineId,
          firstName: '',
          treatmentType: a.treatmentType,
          concluded: false,
        })),
      sessions: clinicalSessions,
      now,
      holidays,
    });
    const previous: Record<string, PreviousSlot | null> = {};
    for (const d of disciplines) {
      previous[d.id] = computePreviousSlot({ disciplineId: d.id, sessions: clinicalSessions, now, holidays });
    }
    return { ...this.freshness(state), items, previous };
  }

  private freshness(state: SyncState | null): { syncedAt: Date | null; stale: boolean } {
    const syncedAt = state?.lastSuccessAt ?? null;
    const stale =
      !state || state.result !== 'OK' || !syncedAt || this.now().getTime() - syncedAt.getTime() > STALE_AFTER_MS;
    return { syncedAt, stale };
  }
}
