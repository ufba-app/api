import {
  transcriptInsights,
  validateTranscript,
  type TranscriptData,
  type TranscriptInsights,
  type ValidationReport,
} from '../../domain/academic';
import type { HistoryExtractor } from '../ports/history-extractor';

export interface ImportedTranscript {
  transcript: TranscriptData;
  /** Divergências entre o declarado no documento e o recalculado das linhas. */
  validation: ValidationReport;
  insights: TranscriptInsights;
}

/**
 * Extrai o histórico do PDF e roda o validador. Divergência não bloqueia: é reportada, porque a
 * extração por IA pode errar e quem chama decide o que fazer.
 */
export async function importTranscript(
  extractor: HistoryExtractor,
  pdf: Buffer,
): Promise<ImportedTranscript> {
  const transcript = await extractor.extract(pdf);
  return {
    transcript,
    validation: validateTranscript(transcript),
    insights: transcriptInsights(transcript),
  };
}
