import { SourceError } from '../../../../application/ports/source-gateway';
import { parseHistoryMenuPostback } from '../parsers';
import type { SigaaSession } from '../session';

export const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

/**
 * Baixa o PDF do "Histórico Escolar" pelo menu do portal. A sessão já leu `portalHtml` (um postback JSF só vale contra uma
 * view que o servidor renderizou nesta sessão). Falhas (sessão perdida, sem vínculo) voltam como HTML 200: nunca entregar
 * isso como documento.
 */
export async function downloadTranscriptPdf(session: SigaaSession, portalHtml: string): Promise<Buffer> {
  const { id, jscookAction } = parseHistoryMenuPostback(portalHtml);
  const pdf = await session.postbackBinary(PORTAL_HOME_PATH, {
    'menu:form_menu_discente': 'menu:form_menu_discente',
    id,
    jscook_action: jscookAction,
  });
  if (!pdf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new SourceError('UNAVAILABLE', `Esperava um PDF do histórico, vieram ${pdf.length} bytes que não começam com %PDF`);
  }
  return pdf;
}
