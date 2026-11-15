/**
 * Tipos clínicos de saída do SIASB. Só o que o ufba.app mostra: nunca nome, prontuário ou id de paciente
 * (o paciente aparece só por `firstName`; o sobrenome nunca entra).
 */
export interface ClinicalDiscipline {
  id: string;
  name: string;
}

export interface ClinicalAttendance {
  id: string;
  disciplineId: string;
  /** Pode ser `''` quando o SIASB não informa o nome do paciente; quem exibe deve tratar. */
  firstName: string;
  treatmentType: 'TRIAGE' | 'PLANNING' | 'URGENCY' | 'UNKNOWN';
  concluded: boolean;
}

export interface ClinicalSession {
  id: string;
  attendanceId: string;
  disciplineId: string;
  disciplineName: string;
  /** Pode ser `''` quando o SIASB não informa o nome do paciente; quem exibe deve tratar. */
  firstName: string;
  professorName: string;
  locationName: string;
  startAt: Date;
  endAt: Date;
  rescheduledStartAt: Date | null;
  statusLabel: string;
}

export interface Procedure {
  id: string;
  name: string;
}
