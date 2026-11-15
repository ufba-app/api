/**
 * O SIASB manda data e hora no horário da Bahia (UTC-03:00, sem horário de verão), muitas vezes sem offset
 * (`2026-11-20T08:00`). Sem offset, vale -03:00. Texto que não é data lança `Error`.
 */
export function parseSiasbDateTime(s: string): Date {
  const text = s.trim();
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const date = new Date(hasOffset ? text : `${text}-03:00`);
  if (Number.isNaN(date.getTime())) throw new Error('Data e hora do SIASB inválida.');
  return date;
}
