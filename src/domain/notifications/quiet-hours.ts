/**
 * Silêncio das 22h às 7h na Bahia (UTC-3 fixo, sem horário de verão). Intervalo [22h, 7h).
 *
 * É uma função PURA à disposição de quem quiser respeitar esse horário (o SIASB usa no próprio `AlertProvider`). O canal
 * genérico (`Notifier`) NÃO aplica silêncio: ele envia a qualquer hora, para servir também a avisos por gatilho.
 */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;
const BAHIA_OFFSET_HOURS = -3;

/** Hora cheia (0-23) do instante no horário da Bahia. */
export function bahiaHour(at: Date): number {
  return (at.getUTCHours() + BAHIA_OFFSET_HOURS + 24) % 24;
}

export function inQuietHours(at: Date): boolean {
  const h = bahiaHour(at);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}
