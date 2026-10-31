/** Aritmética dos períodos letivos ("AAAA.1" e "AAAA.2"). */

function parts(term: string): { year: number; period: number } {
  const [year, period] = term.split('.').map(Number);
  return { year, period };
}

/** "2026.1" → "2026.2"; "2026.2" → "2027.1". */
export function nextTerm(term: string): string {
  const { year, period } = parts(term);
  return period === 1 ? `${year}.2` : `${year + 1}.1`;
}

/** Negativo quando `a` vem antes de `b`. */
export function compareTerms(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Semestres entre `from` e `to`; negativo se `to` já passou. */
export function termDistance(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return (b.year - a.year) * 2 + (b.period - a.period);
}
