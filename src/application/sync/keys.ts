import type { FetchedEvent, FetchedGrade, FetchedItem } from '../ports/source-gateway';

/**
 * Chave natural de cada entidade dentro de uma conta. É o `externalId` que `detectChanges` e
 * `SyncRepository.storedHashes` trocam entre si.
 */
const SEP = '|';

export const itemKey = (i: Pick<FetchedItem, 'courseExternalId' | 'kind' | 'externalId'>): string =>
  [i.courseExternalId, i.kind, i.externalId].join(SEP);

export const gradeKey = (g: Pick<FetchedGrade, 'courseExternalId' | 'externalId'>): string =>
  [g.courseExternalId, g.externalId].join(SEP);

export const eventKey = (e: Pick<FetchedEvent, 'calendarId' | 'externalId'>): string =>
  [e.calendarId, e.externalId].join(SEP);

/** Separa os `n` primeiros segmentos; o resto (que pode conter `|`) volta inteiro no último. */
export function splitKey(key: string, n: number): string[] {
  const parts = key.split(SEP);
  if (parts.length <= n) return parts;
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(SEP)];
}
