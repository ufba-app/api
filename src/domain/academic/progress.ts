import { checkExpression, citedCodes } from './prerequisite';

/**
 * Vida acadêmica = histórico do aluno + currículo ATIVO do curso (docs/specs/2026-11-15-vida-academica.md §4.2).
 *
 * O histórico cobra pelo currículo do aluno e o catálogo é sempre o Ativo (na UFBA todos se adequam ao mais novo). A ponte
 * são as equivalências, aplicadas aqui por lógica pura e determinística: nada de IA nem de rede. O resultado é uma
 * **estimativa**: o histórico é a fonte oficial do que foi feito; a adequação ao currículo novo é cálculo nosso.
 */

/** Situações que contam como cumpridas (legenda do histórico da UFBA). */
export const COMPLETED_STATUSES: readonly string[] = ['APR', 'DISP', 'CUMP', 'INCORP', 'TRANS'];
const ENROLLED_STATUS = 'MATR';
/** Situações de uma tentativa que não deu certo: o componente volta a ser "a refazer" (cancelamento não conta como tentativa). */
const FAILED_STATUSES: readonly string[] = ['REP', 'REPF', 'REPMF', 'TRANC'];
const TERM_PATTERN = /^\d{4}\.\d$/;
/** O ENADE aparece entre os pendentes obrigatórios do histórico, mas não é componente curricular. */
export const ENADE_CODE = 'ENADE';

export const isCompleted = (status: string): boolean => COMPLETED_STATUSES.includes(status);

// ---- entradas (estruturalmente compatíveis com o contrato do histórico e com o catálogo; o domínio não importa nenhum) ----

export interface TranscriptEntryInput {
  term: string;
  nature: string | null;
  code: string;
  name: string;
  hours: number;
  grade: number | null;
  status: string;
}

export interface PendingInput {
  code: string;
  name: string;
  hours: number;
  enrolled: boolean;
}

export interface HoursBlockInput {
  required: number;
  completed: number;
  pending: number;
}

export interface TranscriptInput {
  entries: readonly TranscriptEntryInput[];
  pending: readonly PendingInput[];
  /** Quadro de horas que o próprio documento declara (fonte oficial das horas feitas). */
  hours?: {
    mandatory?: HoursBlockInput;
    elective?: HoursBlockInput;
    complementary?: HoursBlockInput;
    total?: HoursBlockInput;
  };
  /** Linhas de "Equivalências" do documento: "Cumpriu ABCD01 através de EFGH02 (60h)". */
  equivalences: readonly string[];
  currentTerm: number | null;
  /** Código do currículo do aluno ("G20251"), só para informar se é o mesmo do Ativo. */
  curriculumCode?: string;
}

export type ComponentNature = 'REQUIRED' | 'ELECTIVE' | 'COMPLEMENTARY';

export interface CurriculumComponentInput {
  code: string;
  name: string;
  hours: number;
  nature: ComponentNature;
  term: number | null;
  prerequisiteExpr: string | null;
  corequisiteExpr: string | null;
  equivalenceExpr: string | null;
  /** Unidade responsável pelo componente (departamento), quando o SIGAA a imprime. */
  responsibleUnit?: string | null;
}

export interface CurriculumInput {
  code: string;
  totalHours: number;
  requiredHours: number;
  minElectiveHours: number;
  minComplementaryHours: number;
  minTerms: number;
  avgTerms: number;
  maxTerms: number;
  components: readonly CurriculumComponentInput[];
}

// ---- saída ----

export type ComponentState =
  /** Aprovado (ou dispensado, cumprido…) no próprio código. */
  | 'DONE'
  /** Cumprido por equivalência (a do currículo Ativo ou a que o próprio histórico declara). */
  | 'DONE_VIA_EQUIVALENCE'
  | 'ENROLLED'
  /** Falta e os pré-requisitos estão atendidos. */
  | 'AVAILABLE'
  | 'BLOCKED';

/** A tentativa que vale no histórico: a última aprovada, se houve; senão a última. */
export interface LastAttempt {
  /** "2025.2"; nulo nas linhas sem semestre (aproveitamento de estudos, dispensa). */
  term: string | null;
  grade: number | null;
  status: string;
}

export interface ComponentProgress {
  code: string;
  name: string;
  hours: number;
  nature: ComponentNature;
  term: number | null;
  state: ComponentState;
  /** Códigos que cumpriram este componente por equivalência. */
  via: string[];
  /** Códigos citados no pré-requisito que o aluno ainda não cumpriu (só em `BLOCKED`). */
  missingPrerequisites: string[];
  /** O pré-requisito não é uma expressão de códigos que dê para verificar (ex.: carga mínima): confira no SIGAA. */
  prerequisiteUnverifiable: boolean;
  prerequisiteExpr: string | null;
  /** Texto do co-requisito como o SIGAA imprime; só é mostrado, o estado de cumprimento dele não é calculado. */
  corequisiteExpr: string | null;
  equivalenceExpr: string | null;
  responsibleUnit: string | null;
  /** Obrigatório de semestre anterior ao atual que ainda falta. */
  late: boolean;
  /** Última tentativa no histórico (semestre, nota, situação); nulo se a pessoa nunca cursou este código. */
  lastAttempt: LastAttempt | null;
  /** A última tentativa foi reprovação ou trancamento e o componente ainda não foi cumprido nem está em curso. */
  toRedo: boolean;
}

export interface NatureHours {
  needed: number;
  completed: number;
  remaining: number;
  /** `document`: veio do quadro de horas do histórico; `estimate`: somado dos componentes cumpridos. */
  source: 'document' | 'estimate';
}

export interface Progress {
  curriculumCode: string;
  /** O aluno está no mesmo currículo do Ativo (o histórico e a grade falam do mesmo currículo). */
  sameCurriculum: boolean | null;
  /** A adequação ao currículo Ativo é estimativa; a tela deve dizer isso. */
  estimate: true;
  required: ComponentProgress[];
  electives: ComponentProgress[];
  complementary: ComponentProgress[];
  hours: { required: NatureHours; elective: NatureHours; complementary: NatureHours; total: NatureHours };
  percentComplete: number | null;
  /** Horas dos obrigatórios que ainda faltam cursar (exclui os cumpridos e os matriculados). */
  requiredHoursToTake: number;
  currentTerm: number | null;
  terms: { min: number; avg: number; max: number };
  divergences: {
    /** Pendentes do histórico que o Ativo não tem e nenhum componente dele substitui (obsoletas puras). */
    obsoletePending: string[];
    /** Pendentes do histórico que o Ativo substitui por outro componente: `{ code, substitutedBy }`. */
    substitutedPending: { code: string; substitutedBy: string }[];
    /** O histórico ainda cobra, mas pela grade nova (e suas equivalências) já está cumprido. */
    satisfiedByAdequation: string[];
    /** Obrigatórios do Ativo que faltam e que o histórico (currículo antigo) não cobrava. */
    newInCurriculum: string[];
  };
}

const HISTORY_EQUIVALENCE = /Cumpriu\s+([A-Za-z]{1,6}\d{1,4}[A-Za-z]?)\s+atrav[eé]s\s+d[eo]\s+([A-Za-z]{1,6}\d{1,4}[A-Za-z]?)/gi;

/** "Cumpriu ABCD01 através de EFGH02 (60h)" → ABCD01 foi cumprido por EFGH02. */
export function parseHistoryEquivalences(lines: readonly string[]): { fulfilled: string; through: string }[] {
  const out: { fulfilled: string; through: string }[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(HISTORY_EQUIVALENCE)) out.push({ fulfilled: m[1].toUpperCase(), through: m[2].toUpperCase() });
  }
  return out;
}

const byTermThenCode = (a: ComponentProgress, b: ComponentProgress) =>
  (a.term ?? Number.MAX_SAFE_INTEGER) - (b.term ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code);

export function buildProgress(transcript: TranscriptInput, curriculum: CurriculumInput): Progress {
  const components = curriculum.components;
  const doneDirect = new Set(transcript.entries.filter((e) => isCompleted(e.status)).map((e) => e.code));

  // O que o próprio histórico declara como cumprido por outro componente.
  const viaHistory = new Map<string, string[]>();
  for (const { fulfilled, through } of parseHistoryEquivalences(transcript.equivalences)) {
    viaHistory.set(fulfilled, [...(viaHistory.get(fulfilled) ?? []), through]);
  }

  // Cumpridos = diretos + declarados pelo histórico + os que o Ativo declara equivalentes a algo que o aluno já cumpriu.
  // Até estabilizar: uma equivalência cumprida pode satisfazer a expressão de outra.
  const done = new Set<string>([...doneDirect, ...viaHistory.keys()]);
  const viaEquivalence = new Map<string, string[]>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of components) {
      if (done.has(c.code) || !c.equivalenceExpr) continue;
      if (checkExpression(c.equivalenceExpr, done) === 'MET') {
        done.add(c.code);
        viaEquivalence.set(c.code, citedCodes(c.equivalenceExpr).filter((x) => x !== c.code && done.has(x)));
        changed = true;
      }
    }
  }

  const attemptsByCode = new Map<string, TranscriptEntryInput[]>();
  for (const e of transcript.entries) attemptsByCode.set(e.code, [...(attemptsByCode.get(e.code) ?? []), e]);
  const termKey = (t: string) => (TERM_PATTERN.test(t) ? t : '');
  const lastAttemptOf = (code: string): LastAttempt | null => {
    const all = attemptsByCode.get(code);
    if (!all) return null;
    const completed = all.filter((e) => isCompleted(e.status));
    const pool = completed.length > 0 ? completed : all;
    const last = pool.reduce((a, b) => (termKey(b.term) >= termKey(a.term) ? b : a));
    return { term: TERM_PATTERN.test(last.term) ? last.term : null, grade: last.grade, status: last.status };
  };

  const enrolledCodes = new Set<string>([
    ...transcript.entries.filter((e) => e.status === ENROLLED_STATUS).map((e) => e.code),
    ...transcript.pending.filter((p) => p.enrolled).map((p) => p.code),
  ]);

  const progressOf = (c: CurriculumComponentInput): ComponentProgress => {
    const base = {
      code: c.code,
      name: c.name,
      hours: c.hours,
      nature: c.nature,
      term: c.term,
      prerequisiteExpr: c.prerequisiteExpr,
      corequisiteExpr: c.corequisiteExpr,
      equivalenceExpr: c.equivalenceExpr,
      responsibleUnit: c.responsibleUnit ?? null,
    };
    const lastAttempt = lastAttemptOf(c.code);
    const failedBefore = lastAttempt !== null && FAILED_STATUSES.includes(lastAttempt.status);
    const make = (state: ComponentState, extra: Partial<ComponentProgress> = {}): ComponentProgress => ({
      ...base,
      state,
      via: [],
      missingPrerequisites: [],
      prerequisiteUnverifiable: false,
      late: false,
      lastAttempt,
      toRedo: false,
      ...extra,
    });

    if (doneDirect.has(c.code)) return make('DONE');
    if (viaHistory.has(c.code) || viaEquivalence.has(c.code)) {
      return make('DONE_VIA_EQUIVALENCE', { via: [...new Set([...(viaHistory.get(c.code) ?? []), ...(viaEquivalence.get(c.code) ?? [])])] });
    }
    const late = c.nature === 'REQUIRED' && c.term !== null && transcript.currentTerm !== null && c.term < transcript.currentTerm;
    if (enrolledCodes.has(c.code) || (c.equivalenceExpr && checkExpression(c.equivalenceExpr, enrolledCodes) === 'MET')) {
      return make('ENROLLED');
    }
    const check = checkExpression(c.prerequisiteExpr, done);
    if (check === 'MET') return make('AVAILABLE', { late, toRedo: failedBefore });
    return make('BLOCKED', {
      late,
      toRedo: failedBefore,
      prerequisiteUnverifiable: check === 'UNKNOWN',
      missingPrerequisites: check === 'NOT_MET' ? citedCodes(c.prerequisiteExpr).filter((x) => !done.has(x)) : [],
    });
  };

  const all = components.map(progressOf);
  const required = all.filter((c) => c.nature === 'REQUIRED').sort(byTermThenCode);
  const electives = all.filter((c) => c.nature === 'ELECTIVE').sort(byTermThenCode);
  const complementary = all.filter((c) => c.nature === 'COMPLEMENTARY').sort(byTermThenCode);

  const isDone = (c: ComponentProgress) => c.state === 'DONE' || c.state === 'DONE_VIA_EQUIVALENCE';
  const estimateHours = (list: ComponentProgress[]) => list.filter(isDone).reduce((s, c) => s + c.hours, 0);
  const natureHours = (needed: number, doc: HoursBlockInput | undefined, estimated: number): NatureHours => {
    const completed = doc ? doc.completed : estimated;
    return { needed, completed, remaining: Math.max(0, needed - completed), source: doc ? 'document' : 'estimate' };
  };
  const hours = {
    required: natureHours(curriculum.requiredHours, transcript.hours?.mandatory, estimateHours(required)),
    elective: natureHours(curriculum.minElectiveHours, transcript.hours?.elective, estimateHours(electives)),
    complementary: natureHours(curriculum.minComplementaryHours, transcript.hours?.complementary, estimateHours(complementary)),
  };
  const totalCompleted = transcript.hours?.total?.completed ?? hours.required.completed + hours.elective.completed + hours.complementary.completed;
  const total: NatureHours = {
    needed: curriculum.totalHours,
    completed: totalCompleted,
    remaining: Math.max(0, curriculum.totalHours - totalCompleted),
    source: transcript.hours?.total ? 'document' : 'estimate',
  };

  // Divergências entre o histórico (currículo do aluno) e o Ativo.
  const byCode = new Map(components.map((c) => [c.code, c]));
  const obsoletePending: string[] = [];
  const substitutedPending: { code: string; substitutedBy: string }[] = [];
  const documentPendingMapped = new Set<string>();
  for (const p of transcript.pending) {
    if (p.code === ENADE_CODE) continue;
    if (byCode.has(p.code)) {
      documentPendingMapped.add(p.code);
      continue;
    }
    const substitute = components.find((c) => citedCodes(c.equivalenceExpr).includes(p.code));
    if (substitute) {
      substitutedPending.push({ code: p.code, substitutedBy: substitute.code });
      documentPendingMapped.add(substitute.code);
    } else {
      obsoletePending.push(p.code);
    }
  }
  const computedPending = required.filter((c) => !isDone(c)).map((c) => c.code);
  const satisfiedByAdequation = [...documentPendingMapped].filter((code) => !computedPending.includes(code)).sort();
  const newInCurriculum = computedPending.filter((code) => !documentPendingMapped.has(code)).sort();

  return {
    curriculumCode: curriculum.code,
    sameCurriculum: transcript.curriculumCode ? transcript.curriculumCode.split(/\s|-/)[0] === curriculum.code : null,
    estimate: true,
    required,
    electives,
    complementary,
    hours: { ...hours, total },
    percentComplete: curriculum.totalHours > 0 ? Math.min(100, Math.round((totalCompleted / curriculum.totalHours) * 1000) / 10) : null,
    requiredHoursToTake: required.filter((c) => c.state === 'AVAILABLE' || c.state === 'BLOCKED').reduce((s, c) => s + c.hours, 0),
    currentTerm: transcript.currentTerm,
    terms: { min: curriculum.minTerms, avg: curriculum.avgTerms, max: curriculum.maxTerms },
    divergences: {
      obsoletePending: obsoletePending.sort(),
      substitutedPending: substitutedPending.sort((a, b) => a.code.localeCompare(b.code)),
      satisfiedByAdequation,
      newInCurriculum,
    },
  };
}

// ---- conferência do histórico com o curso (§4.3): uma invariante a mais, determinística ----

export interface CrossCheck {
  /** Obrigatórios (OB) lidos que não estão no Ativo nem em nenhuma equivalência dele: obsoletos puros ou leitura errada. */
  unknownRequired: string[];
  /** Mesmo código, horas diferentes entre o histórico e o catálogo. */
  hourMismatches: { code: string; document: number; catalog: number }[];
  /** Obrigatórios lidos que não estão no Ativo mas têm equivalente nele (esperado: currículo antigo). */
  equivalentRequired: string[];
}

/**
 * Cada linha lida pelo histórico é conferida contra o curso, sem rede e sem IA. Código que não existe em lugar nenhum pode
 * ser uma leitura errada da IA que a aritmética do CR não pega; código de um currículo antigo que o Ativo substitui é
 * esperado. Optativas (OP, EP, LV…) não entram: podem ser de qualquer departamento e não estar na lista do curso.
 */
export function crossCheckTranscript(entries: readonly TranscriptEntryInput[], components: readonly CurriculumComponentInput[]): CrossCheck {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const cited = new Set(components.flatMap((c) => citedCodes(c.equivalenceExpr)));
  const unknownRequired = new Set<string>();
  const equivalentRequired = new Set<string>();
  const hourMismatches: CrossCheck['hourMismatches'] = [];
  for (const e of entries) {
    const known = byCode.get(e.code);
    if (known) {
      if (known.hours !== e.hours) hourMismatches.push({ code: e.code, document: e.hours, catalog: known.hours });
    } else if (e.nature === 'OB') {
      (cited.has(e.code) ? equivalentRequired : unknownRequired).add(e.code);
    }
  }
  return {
    unknownRequired: [...unknownRequired].sort(),
    hourMismatches: hourMismatches.sort((a, b) => a.code.localeCompare(b.code)),
    equivalentRequired: [...equivalentRequired].sort(),
  };
}
