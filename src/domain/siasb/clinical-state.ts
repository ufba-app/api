import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from './types';

export type ClinicalState = 'NO_PATIENT' | 'NO_SESSION' | 'SCHEDULED';

const MARKED = new Set(['confirmado', 'nova', 'agendado pelo sistema', 'solicitacao de reagendamento']);

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Sessão que ainda vale: só os rótulos conhecidos como "marcada". Rótulo desconhecido não conta. */
export function isMarked(statusLabel: string): boolean {
  return MARKED.has(normalize(statusLabel));
}

export function computeStates(i: {
  disciplines: ClinicalDiscipline[];
  activeAttendances: ClinicalAttendance[];
  sessions: ClinicalSession[];
  now: Date;
}): { disciplineId: string; state: ClinicalState }[] {
  return i.disciplines.map((d) => {
    const ids = new Set(i.activeAttendances.filter((a) => a.disciplineId === d.id).map((a) => a.id));
    if (ids.size === 0) return { disciplineId: d.id, state: 'NO_PATIENT' as const };
    const scheduled = i.sessions.some(
      (s) => ids.has(s.attendanceId) && isMarked(s.statusLabel) && s.startAt.getTime() > i.now.getTime(),
    );
    return { disciplineId: d.id, state: scheduled ? ('SCHEDULED' as const) : ('NO_SESSION' as const) };
  });
}
