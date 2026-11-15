import type { TranscriptDocument } from '../academic/transcript/contract';

/**
 * Um trecho de texto do PDF do histórico com a posição em que foi pintado. A posição é o ponto: o PDF é gerado
 * (JasperReports via iText) numa ordem que separa o rótulo do valor, e o texto corrido de qualquer extrator põe "Nome:"
 * três linhas longe do nome. Só pelas bandas de x/y dá para recuperar a tabela.
 */
export interface TextItem {
  page: number;
  x: number;
  y: number;
  text: string;
}

/** PDF do histórico → itens de texto posicionais. */
export abstract class PdfTextExtractor {
  abstract extract(pdf: Buffer): Promise<TextItem[]>;
}

export interface TranscriptReadUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Lê o texto REDIGIDO do histórico (identidade e docentes já fora) e devolve o documento no contrato. A implementação
 * padrão é o Haiku 5.5 da Anthropic; o resto do código não conhece o provedor.
 */
export abstract class TranscriptReader {
  abstract read(redactedText: string): Promise<{ document: TranscriptDocument; usage?: TranscriptReadUsage }>;
}
