import type { ClinicalSession } from '../../domain/siasb/types';
import type { AcademicCalendar } from '../ports/academic-calendar';
import type { SecretCipher } from '../ports/secret-cipher';
import type { SiasbCopyRepository, SyncState } from '../ports/siasb-copy';

import { DAY_MS, MAX_AHEAD_DAYS } from './session-period';
import { computePreviousSlot, computeSituation, historyWindow, type DisciplineSituation, type Holidays } from './situation';

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
    const { syncedAt, stale } = this.freshness(state, this.now());
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
  async situation(
    userId: string,
    now: Date,
    knownState?: SyncState | null,
  ): Promise<{
    syncedAt: Date | null;
    stale: boolean;
    items: DisciplineSituation[];
    /** Por disciplina: o último horário da clínica cujo prazo já passou (base do "Prazo perdido"). */
    previous: Record<string, PreviousSlot | null>;
  }> {
    const [from, to] = historyWindow(now);
    const [state, disciplines, attendances, sessions, holidays] = await Promise.all([
      knownState !== undefined ? Promise.resolve(knownState) : this.copy.state(userId),
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
    // Calendário próprio para o horário anterior: um feriado entre o prazo avisado e agora não pode mudar o prazo.
    let previousHolidays: Holidays = { known: false, dates: [] };
    try {
      previousHolidays = await this.academicCalendar.holidays(
        new Date(now.getTime() - 14 * DAY_MS),
        new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS),
      );
    } catch {
      /* sem calendário: segue sem feriados, nunca falha a avaliação */
    }
    const previous: Record<string, PreviousSlot | null> = {};
    for (const d of disciplines) {
      const prev = computePreviousSlot({ disciplineId: d.id, sessions: clinicalSessions, now, holidays: previousHolidays });
      // Guarda única: o anterior só vale se vem ESTRITAMENTE antes do próximo horário do item. Os itens e o anterior usam
      // calendários de janelas diferentes (known pode divergir, margem 0 x 1 dia útil); no vão entre os dois prazos o
      // horário atual voltaria como "anterior" e geraria um "Prazo perdido" com o prazo ainda aberto.
      const next = items.find((i) => i.disciplineId === d.id)?.nextSlot ?? null;
      previous[d.id] = prev && next && prev.slot.getTime() >= next.getTime() ? null : prev;
    }
    return { ...this.freshness(state, now), items, previous };
  }

  private freshness(state: SyncState | null, now: Date): { syncedAt: Date | null; stale: boolean } {
    const syncedAt = state?.lastSuccessAt ?? null;
    const stale =
      !state || state.result !== 'OK' || !syncedAt || now.getTime() - syncedAt.getTime() > STALE_AFTER_MS;
    return { syncedAt, stale };
  }
}
