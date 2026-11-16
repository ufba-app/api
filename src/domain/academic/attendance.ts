export type AttendanceStatus = 'ok' | 'at_risk' | 'failed';

/** Tudo em aulas (uma aula = 55 min), como o mapa de frequência do SIGAA. */
export interface AttendanceInput {
  presentClasses: number;
  /** Aulas com frequência lançada pelo professor até agora. */
  recordedClasses: number;
  /** Aulas definidas pela carga horária do componente. */
  workloadClasses: number;
}

export interface AttendanceAssessment {
  absentClasses: number;
  allowedAbsentClasses: number;
  /** Pode ser negativo: quanto passou do limite. */
  remainingAbsentClasses: number;
  status: AttendanceStatus;
}

/** Limite de faltas na UFBA: 25% da carga horária. */
const ABSENCE_LIMIT = 0.25;

/** `at_risk` quando restam 1/3 do limite ou menos (calibrado pelo mock: 5 de 17 já é "No limite"). */
const RISK_FRACTION = 1 / 3;

export function assessAttendance(input: AttendanceInput): AttendanceAssessment {
  const { presentClasses, recordedClasses, workloadClasses } = input;
  if (workloadClasses <= 0) {
    return { absentClasses: 0, allowedAbsentClasses: 0, remainingAbsentClasses: 0, status: 'ok' };
  }
  const absentClasses = Math.max(recordedClasses - presentClasses, 0);
  const allowedAbsentClasses = Math.floor(ABSENCE_LIMIT * workloadClasses);
  const remainingAbsentClasses = allowedAbsentClasses - absentClasses;
  const status: AttendanceStatus =
    absentClasses > allowedAbsentClasses
      ? 'failed'
      : remainingAbsentClasses <= allowedAbsentClasses * RISK_FRACTION
        ? 'at_risk'
        : 'ok';
  return { absentClasses, allowedAbsentClasses, remainingAbsentClasses, status };
}
