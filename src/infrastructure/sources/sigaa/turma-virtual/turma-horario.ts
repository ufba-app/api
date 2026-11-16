import * as cheerio from 'cheerio';
import { formatPlace, parseLocation } from '../../../../domain/academic/class-location';
import { parseSchedule, type ClassSchedule } from '../../../../domain/academic/class-schedule';

const HAS_CODE = /\d[MTN]\d/;
const SEMESTER_HEADER = /^\d{4}\.\d$/;
// "ENGG54 - Nome": quando o portal traz o código do componente junto do nome (o da UFBA costuma trazer só o nome).
const COURSE_CODE_AND_NAME = /^([A-Z]{2,4}\d{2,3})\s*-\s*(.+)$/;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Lê as linhas da tabela de turmas do portal do discente (a MESMA página que `parseTurmaVirtualTokens` já lê, sem requisição
 * a mais): para cada linha com um código de horário ("35T45 (18/08/2026 - 19/12/2026)"), o nome da turma, o local por dia e o
 * horário. Inclui turmas SEM Turma Virtual (que `parseTurmaVirtualTokens` omite). Como no app antigo (`parsers/turmas-horario.ts`,
 * testado contra o portal real): a linha de cabeçalho de semestre ("2026.2", uma célula só) marca as linhas seguintes; o nome vem do
 * link da célula `td.descricao` (ou do `span`); `td.info` é, em ordem, o local e o horário; vários códigos na mesma célula dividem
 * um período só; "CODIGO - Nome" separa o código do componente. Linha sem horário reconhecível não vira turma (não inventa). Não há
 * número da turma nem docente nesta página (isso é do atestado de matrícula).
 */
export function parseTurmasHorario(html: string): ClassSchedule[] {
  const $ = cheerio.load(html);
  const out: ClassSchedule[] = [];
  let semester: string | null = null;

  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length === 1) {
      const text = clean($(tds[0]).text());
      if (SEMESTER_HEADER.test(text)) semester = text;
      return;
    }
    if (tds.length < 2) return;

    // Estrutura real: td.descricao + td.info (local) + td.info (horário). Sem as classes, cai na posição: nome na primeira
    // célula e o horário na primeira célula seguinte que tenha código.
    const info = $(tr).find('td.info').toArray().map((td) => clean($(td).text()));
    const cells = tds.toArray().map((td) => clean($(td).text()));
    let scheduleText: string;
    let local: string;
    if ($(tr).find('td.descricao').length > 0 && info.length >= 2) {
      local = info[0];
      scheduleText = info[1];
    } else {
      const at = cells.findIndex((c, i) => i > 0 && HAS_CODE.test(c));
      if (at < 0) return;
      scheduleText = cells[at];
      local = at >= 2 ? cells[at - 1] : '';
    }
    const parsed = parseSchedule(scheduleText);
    if (!parsed) return;

    const $name = $(tr).find('td.descricao').first().length ? $(tr).find('td.descricao').first() : tds.first();
    const raw = clean($name.find('a').first().text() || $name.find('span').first().text() || $name.text());
    if (!raw) return;
    const m = COURSE_CODE_AND_NAME.exec(raw);
    const name = m ? m[2].trim() : raw;

    const weekdays = [...new Set(parsed.blocks.flatMap((b) => b.weekdays))];
    const placeByWeekday: Record<number, string | null> = {};
    for (const [day, loc] of parseLocation(local, weekdays)) placeByWeekday[day] = formatPlace(loc);

    out.push({ name, courseCode: m ? m[1] : null, semester, placeByWeekday, code: scheduleText, ...parsed });
  });
  return out;
}
