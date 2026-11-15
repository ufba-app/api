import type { CalendarReader, CalendarReadUsage } from '../ports/calendar';
import type { CalendarContract } from './contract';
import { checkAll } from './invariants';

/**
 * A IA lê o documento inteiro; as invariantes decidem `verified`. Só lança se a chamada ao modelo falhar. Uma leitura que
 * não fecha é entregue com `verified: false` e os motivos em `warnings`. Origem: `dev/ufba/poc-calendario/src/leitura.ts`.
 */
export async function readCalendar(
  text: string,
  reader: Pick<CalendarReader, 'read'>,
  pdf?: Buffer,
): Promise<CalendarContract & { usage?: CalendarReadUsage }> {
  const { document, usage } = await reader.read(text, pdf);
  const { hard, soft } = checkAll(document, text);
  return {
    contractVersion: '1',
    ...document,
    verification: { verified: hard.length === 0, warnings: [...hard, ...soft], reader: 'ai' },
    usage,
  };
}
