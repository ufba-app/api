import * as cheerio from 'cheerio';
import { parseSchedule, type ClassSchedule } from '../../../../domain/academic/class-schedule';

const HAS_CODE = /\d[MTN]\d/;

/**
 * Lê as linhas da tabela de turmas do portal do discente (a MESMA página que `parseTurmaVirtualTokens` já lê, sem requisição
 * a mais): para cada linha com um código de horário ("35T45 (18/08/2026 - 19/12/2026)"), o nome da turma, a sala e o horário.
 * Inclui turmas SEM Turma Virtual (que `parseTurmaVirtualTokens` omite). Linha sem horário reconhecível não vira turma (não
 * inventa). Não há código do componente nem número da turma nesta página (confirmado nos fixtures).
 */
export function parseTurmasHorario(html: string): ClassSchedule[] {
  const $ = cheerio.load(html);
  const out: ClassSchedule[] = [];
  $('tr').each((_, tr) => {
    const cells = $(tr)
      .children('td')
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, ' ').trim());
    if (cells.length < 2) return;
    const at = cells.findIndex((c, i) => i > 0 && HAS_CODE.test(c));
    if (at < 0) return;
    const parsed = parseSchedule(cells[at]);
    const $first = $(tr).children('td').first();
    const name = ($first.find('a').first().text() || $first.text()).replace(/\s+/g, ' ').trim();
    if (!parsed || !name) return;
    const room = at >= 2 ? cells[at - 1] || null : null;
    out.push({ name, room, code: cells[at], ...parsed });
  });
  return out;
}
