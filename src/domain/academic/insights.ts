import {
  ENADE_CODE,
  isCompleted,
  type TranscriptData,
  type TranscriptEntry,
  type TranscriptPending,
} from './transcript';
import { compareTerms } from './term';

/**
 * CR: média das notas ponderada pela carga horária. Trancados e matriculados (sem nota)
 * ficam fora do numerador e do denominador. Nulo quando nada tem nota.
 */
export function computeCr(entries: readonly TranscriptEntry[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const e of entries) {
    if (e.grade === null) continue;
    weight += e.hours;
    sum += e.hours * e.grade;
  }
  return weight > 0 ? sum / weight : null;
}

export interface TermSummary {
  term: string;
  entries: TranscriptEntry[];
  /** Horas das linhas com nota. */
  hoursGraded: number;
  hoursCompleted: number;
  /** CR só do semestre. */
  cr: number | null;
  /** CR acumulado até este semestre, inclusive. */
  cumulativeCr: number | null;
  cumulativeHoursCompleted: number;
  /** Contagem por status. */
  counts: Record<string, number>;
}

/** Trajetória semestre a semestre, em ordem cronológica. */
export function termTrajectory(
  entries: readonly TranscriptEntry[],
): TermSummary[] {
  const terms = [...new Set(entries.map((e) => e.term))].sort(compareTerms);
  const out: TermSummary[] = [];
  const seen: TranscriptEntry[] = [];
  let cumulativeHours = 0;

  for (const term of terms) {
    const inTerm = entries.filter((e) => e.term === term);
    seen.push(...inTerm);
    const hoursCompleted = inTerm
      .filter(isCompleted)
      .reduce((s, e) => s + e.hours, 0);
    cumulativeHours += hoursCompleted;
    const counts: Record<string, number> = {};
    for (const e of inTerm) counts[e.status] = (counts[e.status] ?? 0) + 1;
    out.push({
      term,
      entries: inTerm,
      hoursGraded: inTerm
        .filter((e) => e.grade !== null)
        .reduce((s, e) => s + e.hours, 0),
      hoursCompleted,
      cr: computeCr(inTerm),
      cumulativeCr: computeCr(seen),
      cumulativeHoursCompleted: cumulativeHours,
      counts,
    });
  }
  return out;
}

export interface PendingSummary {
  /** Pendentes que ainda não estão sendo cursados (sem ENADE). */
  toTake: TranscriptPending[];
  enrolled: TranscriptPending[];
  /** Há ENADE pendente (não é componente, só aviso). */
  enadePending: boolean;
  hoursToTake: number;
  hoursEnrolled: number;
}

export function pendingSummary(
  pending: readonly TranscriptPending[],
): PendingSummary {
  const real = pending.filter((p) => p.code !== ENADE_CODE);
  const toTake = real.filter((p) => !p.enrolled);
  const enrolled = real.filter((p) => p.enrolled);
  return {
    toTake,
    enrolled,
    enadePending: pending.some((p) => p.code === ENADE_CODE),
    hoursToTake: toTake.reduce((s, p) => s + p.hours, 0),
    hoursEnrolled: enrolled.reduce((s, p) => s + p.hours, 0),
  };
}

export interface CurriculumComponentRef {
  code: string;
  /** Período sugerido na grade. */
  term: number | null;
  prerequisite: string | null;
}

export interface EquivalenceRef {
  code: string;
  equivalentOf: string;
}

export interface QueueItem {
  code: string;
  name: string;
  hours: number;
  /** Nulo na obsoleta pura: nenhum componente da grade com esse código ou equivalente. */
  term: number | null;
  late: boolean;
  prerequisite: string | null;
  /** Código da grade que declara este como equivalente, ou nulo. */
  substitute: string | null;
}

/**
 * Fila de pendentes na ordem em que devem ser alocados: por período da grade (atrasadas saem
 * primeiro por construção), sem período no fim, desempate por código (ordem estável).
 * Portada de `curriculo/fila-de-pendentes` do app antigo.
 */
export function buildPendingQueue(
  pending: readonly TranscriptPending[],
  components: readonly CurriculumComponentRef[],
  equivalences: readonly EquivalenceRef[],
  currentTerm: number,
): QueueItem[] {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const substituteOf = new Map(
    equivalences.map((e) => [e.code, e.equivalentOf]),
  );

  const items = pending
    .filter((p) => !p.enrolled && p.code !== ENADE_CODE)
    .map((p): QueueItem => {
      const own = byCode.get(p.code);
      const substitute = own ? undefined : substituteOf.get(p.code);
      const inCurriculum =
        own ?? (substitute ? byCode.get(substitute) : undefined);
      const term = inCurriculum?.term ?? null;
      return {
        code: p.code,
        name: p.name,
        hours: p.hours,
        term,
        late: term !== null && term < currentTerm,
        prerequisite: inCurriculum?.prerequisite ?? null,
        substitute: substitute ?? null,
      };
    });

  return items.sort((a, b) => {
    const ta = a.term ?? Number.MAX_SAFE_INTEGER;
    const tb = b.term ?? Number.MAX_SAFE_INTEGER;
    return ta - tb || a.code.localeCompare(b.code);
  });
}

export interface TranscriptInsights {
  cr: number | null;
  trajectory: TermSummary[];
  pending: PendingSummary;
  hoursCompleted: number;
}

export function transcriptInsights(t: TranscriptData): TranscriptInsights {
  return {
    cr: computeCr(t.entries),
    trajectory: termTrajectory(t.entries),
    pending: pendingSummary(t.pending),
    hoursCompleted: t.entries
      .filter(isCompleted)
      .reduce((s, e) => s + e.hours, 0),
  };
}
