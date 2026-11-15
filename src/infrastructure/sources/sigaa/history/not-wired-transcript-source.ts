import { TranscriptSource, type TranscriptSnapshot } from '../../../../application/ports/academic';
import { SourceError } from '../../../../application/ports/source-gateway';

/**
 * Fonte do PDF do histórico AINDA NÃO LIGADA ao SIGAA (fase 5 de docs/specs/2026-11-15-vida-academica.md: baixar o PDF
 * pela sessão da pessoa e testar com a conta do André). Enquanto isso, qualquer tentativa vira "SIGAA indisponível", e a
 * importação só existe com `ANTHROPIC_API_KEY` configurada, então nada disto roda em produção por acidente.
 */
export class NotWiredTranscriptSource extends TranscriptSource {
  async fetch(): Promise<TranscriptSnapshot> {
    throw new SourceError('UNAVAILABLE', 'A leitura do histórico no SIGAA ainda não está ligada.');
  }
}
