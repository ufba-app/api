import { computeCr } from './insights';
import {
  ENADE_CODE,
  isCompleted,
  type TranscriptData,
} from './transcript';

export type DivergenceSeverity = 'error' | 'warning';

export interface Divergence {
  code:
    | 'HOURS_REQUIRED'
    | 'HOURS_ELECTIVE'
    | 'HOURS_ROWS_TOTAL'
    | 'HOURS_TOTAL_COLUMNS'
    | 'HOURS_REQUIRED_PENDING'
    | 'CR_MISMATCH'
    | 'CR_MISSING'
    | 'ENTRY_INVALID';
  severity: DivergenceSeverity;
  message: string;
  declared?: number | null;
  recomputed?: number | null;
}

export interface ValidationReport {
  ok: boolean;
  divergences: Divergence[];
}

const CR_TOLERANCE = 0.0001;

/** Natureza que conta como obrigatória; qualquer outra (OP, EB, EP, LV…) conta como optativa. */
const REQUIRED_NATURE = 'OB';

function check(
  out: Divergence[],
  code: Divergence['code'],
  label: string,
  declared: number,
  recomputed: number,
  severity: DivergenceSeverity = 'error',
): void {
  if (declared !== recomputed) {
    out.push({
      code,
      severity,
      message: `${label}: o documento declara ${declared}h, mas as linhas somam ${recomputed}h.`,
      declared,
      recomputed,
    });
  }
}

/**
 * Recalcula carga horária por natureza e CR a partir das linhas e compara com o declarado.
 * Não lança: devolve as divergências, para quem chama decidir (a extração por IA pode errar).
 * As complementares (ACC) não têm linha na tabela, então ficam fora da soma por linhas.
 */
export function validateTranscript(t: TranscriptData): ValidationReport {
  const divergences: Divergence[] = [];

  for (const e of t.entries) {
    const bad =
      !Number.isFinite(e.hours) ||
      e.hours < 0 ||
      (e.grade !== null &&
        (!Number.isFinite(e.grade) || e.grade < 0 || e.grade > 10));
    if (bad) {
      divergences.push({
        code: 'ENTRY_INVALID',
        severity: 'error',
        message: `Linha ${e.term} ${e.code}: carga horária ou nota inválida (${e.hours}h, nota ${String(e.grade)}).`,
      });
    }
  }

  const done = t.entries.filter(isCompleted);
  const requiredDone = done
    .filter((e) => e.nature === REQUIRED_NATURE)
    .reduce((s, e) => s + e.hours, 0);
  const electiveDone = done
    .filter((e) => e.nature !== REQUIRED_NATURE)
    .reduce((s, e) => s + e.hours, 0);

  const m = t.hoursMatrix;
  const declaredRows = m.required.done + m.elective.done;

  if (requiredDone !== m.required.done || electiveDone !== m.elective.done) {
    if (requiredDone + electiveDone === declaredRows) {
      // O total fecha, mas a divisão entre naturezas não: provável sigla de natureza lida errada.
      check(divergences, 'HOURS_REQUIRED', 'Obrigatórias integralizadas', m.required.done, requiredDone, 'warning');
      check(divergences, 'HOURS_ELECTIVE', 'Optativas integralizadas', m.elective.done, electiveDone, 'warning');
    } else {
      check(divergences, 'HOURS_ROWS_TOTAL', 'Obrigatórias + optativas integralizadas', declaredRows, requiredDone + electiveDone);
      check(divergences, 'HOURS_REQUIRED', 'Obrigatórias integralizadas', m.required.done, requiredDone);
      check(divergences, 'HOURS_ELECTIVE', 'Optativas integralizadas', m.elective.done, electiveDone);
    }
  }

  check(
    divergences,
    'HOURS_TOTAL_COLUMNS',
    'Total integralizado do quadro (obrigatórias + optativas + complementares)',
    m.total.done,
    declaredRows + m.complementary.done,
  );

  const pendingHours = t.pending
    .filter((p) => p.code !== ENADE_CODE)
    .reduce((s, p) => s + p.hours, 0);
  check(
    divergences,
    'HOURS_REQUIRED_PENDING',
    'Obrigatórias pendentes',
    m.required.pending,
    pendingHours,
    'warning',
  );

  const recomputedCr = computeCr(t.entries);
  if (t.cr === null && recomputedCr !== null) {
    divergences.push({
      code: 'CR_MISSING',
      severity: 'error',
      message: 'O documento não traz CR, mas existem componentes com nota.',
      declared: null,
      recomputed: recomputedCr,
    });
  } else if (t.cr !== null && recomputedCr !== null) {
    if (
      !Number.isFinite(recomputedCr) ||
      Math.abs(recomputedCr - t.cr) > CR_TOLERANCE
    ) {
      divergences.push({
        code: 'CR_MISMATCH',
        severity: 'error',
        message: `CR: o documento declara ${t.cr}, mas as linhas dão ${recomputedCr.toFixed(4)}.`,
        declared: t.cr,
        recomputed: recomputedCr,
      });
    }
  }

  return { ok: !divergences.some((d) => d.severity === 'error'), divergences };
}
