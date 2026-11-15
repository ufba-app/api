const DAY_MS = 86_400_000;
const BAHIA_OFFSET_MS = 3 * 3_600_000;

/** Data local da Bahia (UTC-3 fixo) como `YYYY-MM-DD` e dia da semana (0 = domingo). */
function bahiaDay(d: Date): { iso: string; weekday: number } {
  const shifted = new Date(d.getTime() - BAHIA_OFFSET_MS);
  return { iso: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay() };
}

/**
 * Prazo estimado para marcar a sessão: 2 dias úteis antes, mais `marginBusinessDays`, mantendo o horário.
 * Dia útil = não é sábado, domingo nem data de `holidays` (ISO), sempre na data local da Bahia.
 */
export function estimateBookingDeadline(sessionStart: Date, holidays: readonly string[], marginBusinessDays = 0): Date {
  const off = new Set(holidays);
  let t = sessionStart.getTime();
  let remaining = 2 + Math.max(0, marginBusinessDays);
  while (remaining > 0) {
    t -= DAY_MS;
    const { iso, weekday } = bahiaDay(new Date(t));
    if (weekday !== 0 && weekday !== 6 && !off.has(iso)) remaining -= 1;
  }
  return new Date(t);
}
