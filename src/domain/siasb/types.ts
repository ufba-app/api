/**
 * Tipos clínicos de saída do SIASB. Só o que o ufba.app mostra: nunca nome, prontuário ou id de paciente
 * (o paciente aparece só por `initials`).
 */
export interface ClinicalDiscipline {
  id: string;
  name: string;
}

export interface ClinicalAttendance {
  id: string;
  disciplineId: string;
  initials: string;
  treatmentType: 'TRIAGE' | 'PLANNING' | 'URGENCY' | 'UNKNOWN';
  concluded: boolean;
}

export interface ClinicalSession {
  id: string;
  attendanceId: string;
  disciplineId: string;
  disciplineName: string;
  initials: string;
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
