import { PROGRESS_DEFAULT_DAYS } from './progress';

export const DAY_MS = 86_400_000;
export const DEFAULT_RANGE_DAYS = 14;
export const MAX_AHEAD_DAYS = 45;
/** Teto de uma chamada de sessões ao SIASB (spec): nenhuma consulta cobre mais que isso. */
export const MAX_CALL_DAYS = 190;
/** Quanto do passado a cópia cobre. É a janela do `SiasbReader.snapshot`, a fonte de verdade do sincronizador. */
export const SYNC_LOOKBACK_DAYS = PROGRESS_DEFAULT_DAYS;

/** Período pedido fora de ordem (início depois do fim). Mensagem fixa, em pt-BR, sem ecoar a entrada. */
export class InvalidPeriodError extends Error {
  constructor() {
    super('O início do período vem depois do fim.');
    this.name = 'InvalidPeriodError';
  }
}

/**
 * Resolve o período de sessões pedido: sem `range` vale agora + 14 dias; o fim nunca passa de agora + 45 dias; a
 * consulta nunca cobre mais que 190 dias. `from` > `to` lança `InvalidPeriodError`; período todo além do alcance é `empty`.
 */
export function resolveSessionPeriod(
  now: Date,
  range?: { from: Date; to: Date },
): { kind: 'empty' } | { kind: 'range'; from: Date; to: Date } {
  const from = range?.from ?? now;
  const limit = new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS);
  const wanted = range?.to ?? new Date(from.getTime() + DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > wanted.getTime()) throw new InvalidPeriodError();
  const to = wanted.getTime() > limit.getTime() ? limit : wanted;
  if (from.getTime() > to.getTime()) return { kind: 'empty' };
  return { kind: 'range', from: new Date(Math.max(from.getTime(), to.getTime() - MAX_CALL_DAYS * DAY_MS)), to };
}
