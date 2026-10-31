/**
 * Histórico escolar como dado acadêmico puro: sem CPF, nome ou nascimento.
 * `status` e `nature` são texto de propósito (o documento usa muitas siglas; uma nova não deve quebrar a extração).
 */
export interface TranscriptEntry {
  term: string;
  /** Vazio em trancamento. */
  nature: string | null;
  code: string;
  name: string;
  hours: number;
  /** Nulo quando o documento imprime "--". */
  grade: number | null;
  status: string;
  instructor: string | null;
}

export interface TranscriptPending {
  code: string;
  name: string;
  hours: number;
  /** Pendente, mas sendo cursado agora. */
  enrolled: boolean;
}

export interface HoursRow {
  required: number;
  done: number;
  pending: number;
}

/** A matriz de carga horária como o documento a declara. */
export interface HoursMatrix {
  required: HoursRow;
  elective: HoursRow;
  complementary: HoursRow;
  total: HoursRow;
}

export interface TranscriptData {
  /** ISO (AAAA-MM-DD). */
  issuedAt: string;
  curriculumCode: string;
  programName: string;
  currentTerm: number;
  standardTerms: string;
  maxTerms: string;
  cr: number | null;
  iap: number | null;
  hoursMatrix: HoursMatrix;
  entries: TranscriptEntry[];
  pending: TranscriptPending[];
  equivalences: string[];
  notes: string[];
}

/** Situações que concedem carga horária integralizada. */
export const COMPLETED_STATUSES: readonly string[] = [
  'APR',
  'DISP',
  'CUMP',
  'INCORP',
  'TRANS',
];

export function isCompleted(entry: TranscriptEntry): boolean {
  return COMPLETED_STATUSES.includes(entry.status);
}

/** O ENADE aparece entre os pendentes, mas não é componente curricular: sem período nem carga. */
export const ENADE_CODE = 'ENADE';
