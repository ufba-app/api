/** Formatos de data dos avisos (pt-BR, horário da Bahia = UTC-3 fixo, como o resto do SIASB). Funções puras. */
const BAHIA_OFFSET_MS = -3 * 3_600_000;
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const bahia = (d: Date) => new Date(d.getTime() + BAHIA_OFFSET_MS);
const two = (n: number) => String(n).padStart(2, '0');

/** Dia da semana na Bahia, sem "-feira": `sexta`. */
export function bahiaWeekday(d: Date): string {
  return WEEKDAYS[bahia(d).getUTCDay()];
}

/** `sexta, 20/11, às 10h` (ou `às 10h30` quando há minutos). */
export function bahiaDayAndHour(d: Date): string {
  const b = bahia(d);
  const minutes = b.getUTCMinutes();
  const hour = `${b.getUTCHours()}h${minutes === 0 ? '' : two(minutes)}`;
  return `${WEEKDAYS[b.getUTCDay()]}, ${two(b.getUTCDate())}/${two(b.getUTCMonth() + 1)}, às ${hour}`;
}

/** `AAAA-MM-DD` do dia na Bahia (separa um episódio de prazo do seguinte). */
export function bahiaDateKey(d: Date): string {
  const b = bahia(d);
  return `${b.getUTCFullYear()}-${two(b.getUTCMonth() + 1)}-${two(b.getUTCDate())}`;
}
