import { PDFParse } from 'pdf-parse';
import { PdfTextExtractor, type TextItem } from '../../../../application/ports/transcript';

/** O que este módulo precisa de um item de texto do pdfjs; o pdf-parse reexporta o tipo mais largo do próprio pdfjs. */
interface PdfJsItem {
  str?: string;
  transform: number[];
}

/**
 * O `.d.ts` do pdf-parse marca `load()` como privado, mas é o único caminho até o `PDFDocumentProxy` do pdfjs: a superfície
 * pública (`getText`, `getTable`) só oferece texto corrido e tabelas detectadas por geometria, e nenhuma carrega a posição
 * de cada trecho, que é o que a redação e a leitura precisam. Declarar a fatia do formato que usamos e passar por `unknown`
 * dá o valor sem erro de acesso privado e sem `any` vazando.
 */
interface PdfJsDocument {
  numPages: number;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ items: PdfJsItem[] }> }>;
}
interface PdfParseWithLoad {
  load(): Promise<PdfJsDocument>;
}

/** PDF do histórico → itens de texto posicionais (pdf-parse 2, que embute o pdfjs). Não lê nada da rede. */
export class PdfParseTextExtractor extends PdfTextExtractor {
  async extract(pdf: Buffer): Promise<TextItem[]> {
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    const items: TextItem[] = [];
    try {
      const document = await (parser as unknown as PdfParseWithLoad).load();
      for (let page = 1; page <= document.numPages; page += 1) {
        const { items: runs } = await (await document.getPage(page)).getTextContent();
        for (const run of runs) {
          const text = run.str?.trim();
          if (!text) continue;
          // `transform` é a matriz de texto; [4] e [5] são a translação: onde na página este trecho começa.
          items.push({ page, x: run.transform[4], y: run.transform[5], text });
        }
      }
    } finally {
      // O pdfjs cria um worker; deixado vivo, impede o processo (e o Jest) de sair.
      await parser.destroy();
    }
    return items;
  }
}
