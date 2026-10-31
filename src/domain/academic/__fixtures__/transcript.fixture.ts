import type { TranscriptData } from '../transcript';

/** Histórico sintético e internamente consistente. Nenhum dado real. */
export function syntheticTranscript(): TranscriptData {
  return {
    issuedAt: '2026-08-19',
    curriculumCode: '999999',
    programName: 'CURSO FICTICIO',
    currentTerm: 3,
    standardTerms: '8',
    maxTerms: '12',
    cr: 6.7778,
    iap: null,
    hoursMatrix: {
      required: { required: 300, done: 180, pending: 120 },
      elective: { required: 30, done: 30, pending: 0 },
      complementary: { required: 0, done: 0, pending: 0 },
      total: { required: 330, done: 210, pending: 120 },
    },
    entries: [
      { term: '2024.1', nature: 'OB', code: 'MATA01', name: 'CALCULO A', hours: 60, grade: 8, status: 'APR', instructor: null },
      { term: '2024.1', nature: 'OB', code: 'MATA02', name: 'ALGEBRA', hours: 60, grade: 6, status: 'APR', instructor: null },
      { term: '2024.1', nature: null, code: 'MATA03', name: 'LOGICA', hours: 60, grade: null, status: 'TRANC', instructor: null },
      { term: '2024.2', nature: 'OP', code: 'OPT01', name: 'TOPICOS', hours: 30, grade: 9, status: 'APR', instructor: null },
      { term: '2024.2', nature: 'OB', code: 'MATA03', name: 'LOGICA', hours: 60, grade: 7, status: 'APR', instructor: null },
      { term: '2025.1', nature: 'OB', code: 'MATA04', name: 'ESTATISTICA', hours: 60, grade: 5, status: 'REP', instructor: null },
      { term: '2025.1', nature: 'OB', code: 'MATA05', name: 'REDES', hours: 60, grade: null, status: 'MATR', instructor: null },
    ],
    pending: [
      { code: 'MATA04', name: 'ESTATISTICA', hours: 60, enrolled: false },
      { code: 'MATA05', name: 'REDES', hours: 60, enrolled: true },
      { code: 'ENADE', name: 'ENADE', hours: 0, enrolled: false },
    ],
    equivalences: [],
    notes: [],
  };
}
