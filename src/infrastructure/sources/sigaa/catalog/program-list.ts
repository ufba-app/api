import * as cheerio from 'cheerio';

export interface ProgramListItem {
  /** Id interno do curso no SIGAA (`portal.jsf?id=…`). */
  sigaaId: string;
  name: string;
  /** Sede (campus): "SALVADOR". */
  campus: string;
  /** Nível do SIGAA: G (graduação), S, L, T, N. */
  level: string;
}

// portal.jsf?id=1876880&lc=pt_BR&nivel=G
const HREF_PATTERN = /[?&]id=(\d+)&lc=[^&]*&nivel=(\w+)/;

/**
 * `curso/lista.jsf` (pública) mistura dois tipos de linha na mesma `table.listagem`: uma linha larga com o nome da
 * unidade ("EPOLI - ESCOLA POLITÉCNICA") e, abaixo dela, uma linha de duas células por curso. Só o segundo tipo é curso.
 */
export function parseProgramList(html: string): ProgramListItem[] {
  const $ = cheerio.load(html);
  const programs: ProgramListItem[] = [];

  $('table.listagem tr').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (cells.length < 2) return;

    const name = $(cells[0]).text().trim();
    const campus = $(cells[1]).text().trim();
    const href = $row.find('a[title="Visualizar Página do Curso"]').attr('href') ?? '';
    const match = href.match(HREF_PATTERN);
    if (!name || !campus || !match) return;

    programs.push({ sigaaId: match[1], name, campus, level: match[2] });
  });

  return programs;
}
