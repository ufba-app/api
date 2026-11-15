import { PDFParse } from 'pdf-parse';
import { parseCalendarLinks } from '../../../application/calendar/supac-links';
import { CalendarSource, CalendarTextExtractor, type CalendarLink } from '../../../application/ports/calendar';

export const SUPAC_CALENDAR_PAGE = 'https://supac.ufba.br/calendario-academico';
const SUPAC_HOST = 'supac.ufba.br';
const TIMEOUT_MS = 30_000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Só o host da SUPAC (a página é pública; os links vêm do HTML dela, então não se segue link para outro lugar). */
const allowed = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === SUPAC_HOST;
  } catch {
    return false;
  }
};

async function getBytes(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'ufba.app calendario' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!allowed(response.url)) throw new Error('redirecionamento para fora da SUPAC');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('arquivo grande demais');
  return bytes;
}

/** Página e PDFs do calendário na SUPAC (público, sem login, sem dado pessoal). Uma requisição para a página e uma por PDF novo. */
export class SupacCalendarSource extends CalendarSource {
  pageUrl(): string {
    return SUPAC_CALENDAR_PAGE;
  }

  async listLinks(): Promise<CalendarLink[]> {
    const html = (await getBytes(SUPAC_CALENDAR_PAGE, MAX_PAGE_BYTES)).toString('utf8');
    return parseCalendarLinks(html, SUPAC_CALENDAR_PAGE).filter((l) => allowed(l.url));
  }

  async download(url: string): Promise<Buffer> {
    if (!allowed(url)) throw new Error('endereço fora da SUPAC');
    const pdf = await getBytes(url, MAX_PDF_BYTES);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('o arquivo não é um PDF');
    return pdf;
  }
}

/** PDF → texto corrido (pdf-parse 2). A ordem das colunas sai misturada; as invariantes é que conferem. */
export class PdfParseCalendarText extends CalendarTextExtractor {
  async extract(pdf: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
}
