import { inQuietHours, QUIET_END_HOUR, QUIET_START_HOUR } from '../notifications/quiet-hours';

/**
 * Horários dos avisos de prazo (função pura, sem relógio nem I/O). Bahia = UTC-3 fixo, como o resto do SIASB.
 * A cadeia de instantes depende só do prazo, nunca de quando o estado foi detectado: duas execuções do job
 * calculam os mesmos instantes (a chave da anti-duplicata do Notifier).
 */
export const ALERT_GAP_MS = 36 * 3_600_000;
export const LAST_ALERT_AWAKE_MS = 6 * 3_600_000;
export const MIN_GAP_TO_LAST_MS = 12 * 3_600_000;
/** Limite da caminhada para trás: nada mais antigo que 60 dias antes do prazo entra na cadeia (a consulta é finita). */
export const CHAIN_MAX_BACK_MS = 60 * 24 * 3_600_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BAHIA_OFFSET_MS = -3 * HOUR;

/** Início (meia-noite da Bahia) do dia do instante, em ms UTC. */
function bahiaDayStart(ms: number): number {
  const local = ms + BAHIA_OFFSET_MS;
  return Math.floor(local / DAY) * DAY - BAHIA_OFFSET_MS;
}

/** Se `ms` cai no silêncio, devolve as 22h anteriores a ele (nunca depois); senão o próprio `ms`. */
function snapEarlier(ms: number): number {
  const at = new Date(ms);
  if (!inQuietHours(at)) return ms;
  const dayStart = bahiaDayStart(ms);
  return ms - dayStart >= QUIET_START_HOUR * HOUR
    ? dayStart + QUIET_START_HOUR * HOUR
    : dayStart - DAY + QUIET_START_HOUR * HOUR;
}

/** Instante de aviso que cairia no silêncio: recua para as 21h (antes das 22h) do dia da fronteira anterior. */
function awakeEarlier(ms: number): number {
  return inQuietHours(new Date(ms)) ? snapEarlier(ms) - HOUR : ms;
}

/** `at` se acordado; senão as 7h da Bahia seguintes. */
export function nextAwakeInstant(at: Date): Date {
  if (!inQuietHours(at)) return at;
  const dayStart = bahiaDayStart(at.getTime());
  const sevenToday = dayStart + QUIET_END_HOUR * HOUR;
  return new Date(at.getTime() < sevenToday ? sevenToday : sevenToday + DAY);
}

/** Instante do último aviso: 6 horas ACORDADO antes de `deadline`, contando só fora do silêncio. */
export function lastAlertAt(deadline: Date): Date {
  let cur = deadline.getTime();
  let remaining = LAST_ALERT_AWAKE_MS;
  for (;;) {
    cur = snapEarlier(cur);
    const awakeStart = bahiaDayStart(cur) + QUIET_END_HOUR * HOUR;
    const available = cur - awakeStart;
    if (available >= remaining) return new Date(cur - remaining);
    if (available > 0) remaining -= available;
    // Esgotou a janela acordada do dia: continua nas 22h do dia anterior.
    cur = bahiaDayStart(cur) - DAY + QUIET_START_HOUR * HOUR;
  }
}

/** A cadeia completa (do mais antigo ao último), limitada a 60 dias antes do prazo. */
function fullChain(deadline: Date): number[] {
  const last = lastAlertAt(deadline).getTime();
  const floor = deadline.getTime() - CHAIN_MAX_BACK_MS;
  const slots: number[] = [last];
  for (let k = 1; ; k++) {
    const slot = awakeEarlier(last - k * ALERT_GAP_MS);
    if (slot < floor) break;
    // Penúltimo a menos de 12 h do último é descartado.
    if (k === 1 && last - slot < MIN_GAP_TO_LAST_MS) continue;
    slots.unshift(slot);
  }
  return slots;
}

/**
 * A cadeia de avisos de um prazo: parte do último aviso e recua de 36 em 36 h (o que cai no silêncio recua para
 * as 21h, antes das 22h), sem o penúltimo se ficar a menos de 12 h do último. Devolve só `> after` (exclusivo) e
 * `<= upTo`, do mais antigo ao último. A cadeia não depende de `after`/`upTo`; só o recorte muda.
 */
export function alertChain(deadline: Date, after: Date, upTo: Date): Date[] {
  return fullChain(deadline)
    .filter((ms) => ms > after.getTime() && ms <= upTo.getTime())
    .map((ms) => new Date(ms));
}

/** O instante da cadeia imediatamente anterior ou igual a `at`; `null` se a cadeia ainda não começou. */
export function chainSlotAtOrBefore(deadline: Date, at: Date): Date | null {
  const eligible = fullChain(deadline).filter((ms) => ms <= at.getTime());
  return eligible.length ? new Date(eligible[eligible.length - 1]) : null;
}

/**
 * Sem horário conhecido: os instantes são `last + 36 h * k` (k >= 1); o que cair no silêncio vale as 7h seguintes.
 * Devolve o mais recente `<= now`, ou null se ainda não chegou o primeiro.
 */
export function unscheduledSlot(last: Date, now: Date): Date | null {
  const elapsed = now.getTime() - last.getTime();
  for (let k = Math.floor(elapsed / ALERT_GAP_MS); k >= 1; k--) {
    const slot = nextAwakeInstant(new Date(last.getTime() + k * ALERT_GAP_MS));
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

/** O mais recente `<= now` e os anteriores a ele (em ordem crescente). */
export function latestDue(slots: Date[], now: Date): { due: Date | null; skipped: Date[] } {
  const past = slots.filter((s) => s.getTime() <= now.getTime()).sort((a, b) => a.getTime() - b.getTime());
  if (!past.length) return { due: null, skipped: [] };
  return { due: past[past.length - 1], skipped: past.slice(0, -1) };
}
