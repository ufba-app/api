import { isMarked } from '../../domain/siasb/clinical-state';
import { deduceSlots } from '../../domain/siasb/clinic-slots';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from '../../domain/siasb/types';

/** Período padrão do progresso quando o agente não passa as datas do semestre (aproximado). */
export const PROGRESS_DEFAULT_DAYS = 120;
/** Maior período aceito em `clinica_progresso`. */
export const PROGRESS_MAX_DAYS = 190;
/** O site do SIASB carrega ~59 dias de agenda; acima disso não sabemos se a API devolve o período inteiro. */
export const SIASB_AGENDA_DAYS = 59;

export const PROGRESS_NOT_STARTED_WARNING =
  'O período informado ainda não começou; o ritmo não foi calculado.';

export const PROGRESS_PARTIAL_WARNING = 'O SIASB pode devolver só parte do período pedido; confira os números.';

const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;

export interface Progress {
  period: { from: string; to: string; isDefault: boolean };
  disciplines: {
    disciplineId: string;
    disciplineName: string;
    activeAttendances: number;
    concludedInPeriod: number;
    concludedAllTime: number;
    sessionsAttended: number;
    sessionsScheduledAhead: number;
  }[];
  rhythm: { sessionsPerWeek: number | null; weeksWithoutSession: number; usualSlots: { weekday: number; time: string }[] };
  warnings: string[];
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const isCancelled = (s: ClinicalSession) => normalize(s.statusLabel).startsWith('cancel');
const isAttended = (s: ClinicalSession) => normalize(s.statusLabel) === 'atendido';

export function computeProgress(i: {
  disciplines: ClinicalDiscipline[];
  active: ClinicalAttendance[];
  inactive: ClinicalAttendance[];
  /** Tudo o que o SIASB devolveu; o recorte do período é feito aqui. */
  sessions: ClinicalSession[];
  range: { from: Date; to: Date };
  isDefault: boolean;
  now: Date;
}): Progress {
  const { from, to } = i.range;
  const now = i.now;
  const spanMs = Math.round((to.getTime() - from.getTime()) / 60_000) * 60_000;
  const inPeriod = i.sessions.filter((s) => s.startAt >= from && s.startAt <= to);
  const attendancesWithSession = new Set(inPeriod.map((s) => s.attendanceId));

  const disciplines = i.disciplines.map((d) => {
    const mine = inPeriod.filter((s) => s.disciplineId === d.id);
    const inactive = i.inactive.filter((a) => a.disciplineId === d.id && a.concluded);
    return {
      disciplineId: d.id,
      disciplineName: d.name,
      activeAttendances: i.active.filter((a) => a.disciplineId === d.id).length,
      // A lista de atendimentos não traz data de conclusão: "no período" = concluído com alguma sessão nele.
      concludedInPeriod: inactive.filter((a) => attendancesWithSession.has(a.id)).length,
      concludedAllTime: inactive.length,
      sessionsAttended: mine.filter(isAttended).length,
      sessionsScheduledAhead: i.sessions
        .filter((s) => s.disciplineId === d.id && isMarked(s.statusLabel) && s.startAt > now).length,
    };
  });

  // Ritmo só sobre a parte decorrida do período, [from, min(to, now)]. Semanas são blocos de 7 dias contados a
  // partir de `from`; só blocos completos podem ser "semana sem sessão" (o último, parcial, e o que começa depois de
  // agora nunca contam). Em minutos cheios: o fim do dia (23:59:59) conta como o dia inteiro.
  const started = from.getTime() <= now.getTime();
  const end = Math.min(to.getTime(), now.getTime());
  const elapsedMs = started ? Math.round((end - from.getTime()) / 60_000) * 60_000 : 0;
  const elapsed = inPeriod.filter((s) => s.startAt.getTime() <= end);
  const counted = elapsed.filter((s) => isAttended(s) || isMarked(s.statusLabel)).length;
  let weeksWithoutSession = 0;
  for (let w = 0; w < Math.floor(elapsedMs / MS_WEEK); w++) {
    const start = from.getTime() + w * MS_WEEK;
    if (!elapsed.some((s) => !isCancelled(s) && s.startAt.getTime() >= start && s.startAt.getTime() < start + MS_WEEK)) {
      weeksWithoutSession++;
    }
  }
  const sessionsPerWeek =
    elapsedMs < MS_DAY ? null : Math.round((counted / (elapsedMs / MS_WEEK)) * 100) / 100;
  const slots = deduceSlots(i.sessions.filter((s) => isAttended(s) || isMarked(s.statusLabel)));
  const seen = new Set<string>();
  const usualSlots = slots
    .map((s) => ({ weekday: s.weekday, time: s.time }))
    .filter((s) => !seen.has(`${s.weekday}|${s.time}`) && seen.add(`${s.weekday}|${s.time}`));

  return {
    period: { from: from.toISOString(), to: to.toISOString(), isDefault: i.isDefault },
    disciplines,
    rhythm: {
      sessionsPerWeek,
      weeksWithoutSession,
      usualSlots,
    },
    warnings: [
      ...(spanMs > SIASB_AGENDA_DAYS * MS_DAY ? [PROGRESS_PARTIAL_WARNING] : []),
      ...(started ? [] : [PROGRESS_NOT_STARTED_WARNING]),
    ],
  };
}
