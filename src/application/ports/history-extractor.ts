import type { TranscriptData } from '../../domain/academic';

/**
 * Porta: transforma o PDF do histórico em dados acadêmicos. A implementação usa IA, mas quem
 * chama não sabe disso. O resultado nunca traz CPF, nome nem nascimento.
 */
export interface HistoryExtractor {
  extract(pdf: Buffer): Promise<TranscriptData>;
}

export const HISTORY_EXTRACTOR = Symbol('HISTORY_EXTRACTOR');
