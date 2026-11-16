import { computeStates, isMarked, type ClinicalState } from '../../domain/siasb/clinical-state';
import { deduceSlots, nextSlotStart } from '../../domain/siasb/clinic-slots';
import { estimateBookingDeadline } from '../../domain/siasb/deadline';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from '../../domain/siasb/types';
import { isCancelled } from './progress';
import { DAY_MS, MAX_AHEAD_DAYS } from './session-period';

export const HISTORY_DAYS = 60;

export interface DisciplineSituation {
  disciplineId: string;
  disciplineName: string;
  state: ClinicalState;
  nextSlot: Date | null;
  deadline: Date | null;
  estimated: true;
  holidaysConsidered: boolean;
}

export type Holidays = { known: boolean; dates: string[] };

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Sessões que indicam horário fixo da clínica: marcadas ou já atendidas (cancelada/não agendada não conta). */
export const countsForSlots = (s: ClinicalSession) => isMarked(s.statusLabel) || normalize(s.statusLabel) === 'atendido';

/** Janela de sessões lidas: 60 dias atrás até 45 à frente. */
export const historyWindow = (now: Date): [Date, Date] => [
  new Date(now.getTime() - HISTORY_DAYS * DAY_MS),
  new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS),
];

/** Sem calendário oficial, 1 dia útil de margem: o erro cai para o lado de chegar cedo. */
export function deadlineFor(start: Date, holidays: Holidays): Date {
  return estimateBookingDeadline(start, holidays.dates, holidays.known ? 0 : 1);
}

/** Até `max` próximos horários da disciplina com prazo estimado ainda por vir. */
export function usableSlots(
  slots: ReturnType<typeof deduceSlots>,
  disciplineId: string,
  now: Date,
  holidays: Holidays,
  max: number,
): Date[] {
  const found: Date[] = [];
  let cursor = now;
  for (let i = 0; i < 5 + max && found.length < max; i++) {
    const slot = nextSlotStart(slots, disciplineId, cursor);
    if (!slot) break;
    if (deadlineFor(slot, holidays).getTime() > now.getTime()) found.push(slot);
    cursor = slot;
  }
  return found;
}

/** Próximo horário da disciplina cujo prazo estimado ainda não passou; senão, o da semana seguinte. */
export function nextUsableSlot(
  slots: ReturnType<typeof deduceSlots>,
  disciplineId: string,
  now: Date,
  holidays: Holidays,
): Date | null {
  return usableSlots(slots, disciplineId, now, holidays, 1)[0] ?? null;
}

/** Pura: estado, próximo horário e prazo estimado de cada disciplina, sem acesso a fonte. */
export function computeSituation(i: {
  disciplines: ClinicalDiscipline[];
  activeAttendances: ClinicalAttendance[];
  sessions: ClinicalSession[];
  now: Date;
  holidays: Holidays;
}): DisciplineSituation[] {
  const { disciplines, activeAttendances, sessions, now, holidays } = i;
  const states = computeStates({ disciplines, activeAttendances, sessions, now });
  const slots = deduceSlots(sessions.filter(countsForSlots));
  return disciplines.map((disc) => {
    const state = states.find((s) => s.disciplineId === disc.id)?.state ?? 'NO_PATIENT';
    const nextSlot = nextUsableSlot(slots, disc.id, now, holidays);
    return {
      disciplineId: disc.id,
      disciplineName: disc.name,
      state,
      nextSlot,
      deadline: nextSlot ? deadlineFor(nextSlot, holidays) : null,
      estimated: true as const,
      holidaysConsidered: holidays.known,
    };
  });
}

/**
 * Pura: o horário da clínica MAIS RECENTE da disciplina cujo prazo estimado já passou (`deadline <= now`), caminhando
 * a partir de `now − 14 d` com a mesma dedução de horários de `computeSituation`; `null` se nenhum. `covered` = há
 * sessão da disciplina, não cancelada nem "não agendada", cujo início (ou remarcação) cai em [prazo, agora]: reposição em outro
 * dia também cobre; a falta do paciente ainda conta como marcada.
 * Serve ao aviso "Prazo perdido": o prazo perdido vem daqui, não de um palpite de "uma semana antes".
 */
export function computePreviousSlot(i: {
  disciplineId: string;
  sessions: ClinicalSession[];
  now: Date;
  holidays: Holidays;
}): { slot: Date; deadline: Date; covered: boolean } | null {
  const { disciplineId, sessions, now, holidays } = i;
  const slots = deduceSlots(sessions.filter(countsForSlots));
  let cursor = new Date(now.getTime() - 14 * DAY_MS);
  let best: { slot: Date; deadline: Date } | null = null;
  for (let n = 0; n < 12; n++) {
    const slot = nextSlotStart(slots, disciplineId, cursor);
    if (!slot) break;
    const deadline = deadlineFor(slot, holidays);
    if (deadline.getTime() > now.getTime()) break;
    best = { slot, deadline };
    cursor = slot;
  }
  if (!best) return null;
  const from = best.deadline.getTime();
  const to = now.getTime();
  const within = (d: Date | null) => d !== null && d.getTime() >= from && d.getTime() <= to;
  const covered = sessions.some(
    (s) =>
      s.disciplineId === disciplineId &&
      !isCancelled(s) &&
      !normalize(s.statusLabel).startsWith('nao agend') &&
      (within(s.startAt) || within(s.rescheduledStartAt)),
  );
  return { ...best, covered };
}
