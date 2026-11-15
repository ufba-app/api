import type { CalendarLink } from '../ports/calendar';

/** Texto do link = semestre ("2026.2"). É o jeito confiável de saber o `term` antes de ler: o nome do arquivo não serve. */
const TERM_TEXT = /^\s*(\d{4}\.[12])\s*$/;
const ANCHOR = /<a\s[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

const decodeEntities = (s: string): string =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/**
 * Links de calendário da página da SUPAC: `.pdf` cujo texto é exatamente um semestre. As resoluções do CONSEPE e demais PDFs
 * têm outro texto e saem sozinhas. O `href` vem absoluto, com barra inicial ou relativo: resolve contra a própria página.
 * Devolve um link por URL, do semestre mais novo ao mais antigo. Página sem nenhum link devolve lista vazia (quem chama
 * trata como erro: o HTML pode ter mudado).
 */
export function parseCalendarLinks(html: string, pageUrl: string): CalendarLink[] {
  const seen = new Set<string>();
  const links: CalendarLink[] = [];
  for (const m of html.matchAll(ANCHOR)) {
    const text = decodeEntities(m[2]!.replace(/<[^>]*>/g, ''));
    const term = TERM_TEXT.exec(text)?.[1];
    if (!term) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]!.trim()), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (!url.pathname.toLowerCase().endsWith('.pdf')) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ term, url: url.href });
  }
  return links.sort((a, b) => b.term.localeCompare(a.term));
}
