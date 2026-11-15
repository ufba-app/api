import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

export type CatalogNature = 'REQUIRED' | 'ELECTIVE' | 'COMPLEMENTARY';

export interface SummaryComponent {
  /** Id do componente no SIGAA (parâmetro `id` do link de detalhes). */
  sigaaId: string;
  code: string;
  name: string;
  hours: number;
  nature: CatalogNature;
  /** Semestre sugerido; nulo para optativas e complementares. */
  term: number | null;
  /**
   * Todos os pares do `jsfcljs({...})` do link "Visualizar Detalhes do Componente": `id`, `publico` e também o campo
   * JSF da própria linha (`formulario:j_id_jsp_…`), que um navegador envia junto e que o POST de detalhe precisa repetir.
   */
  jsfParams: Record<string, string>;
}

export interface CurriculumSummary {
  /** "2025.2": período letivo de entrada em vigor. */
  implementationTerm: string;
  totalHours: number;
  requiredHours: number;
  minElectiveHours: number;
  minComplementaryHours: number;
  minTerms: number;
  avgTerms: number;
  maxTerms: number;
  components: SummaryComponent[];
  /** Campos ocultos do `#formulario` (sem o ViewState); o POST de detalhe vai para esse mesmo formulário. */
  formFields: Record<string, string>;
}

// "ENG295 - HIGIENE E SEGURANÇA NO TRABALHO - 60h"
const COMPONENT_ROW_PATTERN = /^(\S+)\s*-\s*(.+?)\s*-\s*(\d+)h$/;
const JSF_PARAM_PATTERN = /'([^']+)':'([^']+)'/g;
const HOURS_PATTERN = /(\d+)h/;
const VIEW_STATE_FIELD = 'javax.faces.ViewState';

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

function hoursOf(text: string | undefined): number {
  const match = (text ?? '').match(HOURS_PATTERN);
  if (!match) throw new Error(`Nenhuma carga "Nh" em "${text ?? ''}"`);
  return Number(match[1]);
}

/**
 * `table.formulario` traz os números da estrutura (código, matriz, prazos, cargas) como linhas th/td. Ela só fecha no
 * fim da página (os blocos `table.subFormulario` de cada período ficam aninhados num `<td>`), então `table.formulario tr`
 * também casa com as linhas de componente. Essas só têm `<td>` (sem `<th>`), e a guarda `!th.length` as exclui.
 */
function parseStats($: CheerioAPI): Omit<CurriculumSummary, 'components' | 'formFields'> {
  const stats: Record<string, string> = {};
  $('table.formulario tr').each((_, row) => {
    const $row = $(row);
    const th = $row.find('th').first();
    const td = $row.find('td').first();
    if (!th.length || !td.length) return;
    const label = normalizeLabel(th.text());
    if (label && !(label in stats)) stats[label] = td.text().trim();
  });

  const deadlineRow = $('table.formulario tr')
    .filter((_, row) => normalizeLabel($(row).find('th').first().text()).startsWith('prazo para conclusao'))
    .first();
  const deadlines = deadlineRow.find('td table td');

  return {
    implementationTerm: stats['periodo letivo de entrada em vigor'],
    totalHours: hoursOf(stats['total minima']),
    requiredHours: hoursOf(stats['total']),
    minElectiveHours: hoursOf(stats['carga horaria optativa minima']),
    minComplementaryHours: hoursOf(stats['carga horaria complementar minima']),
    minTerms: Number($(deadlines[0]).text().trim()),
    avgTerms: Number($(deadlines[1]).text().trim()),
    maxTerms: Number($(deadlines[2]).text().trim()),
  };
}

/**
 * Os componentes ficam em blocos `table.subFormulario`: um por período (`<div id="semestreN">`) mais um para optativas
 * e outro para complementares. Cada linha junta código, nome e carga numa célula ("CODIGO - NOME - NNNh") e leva o id do
 * componente no onclick do link de detalhes.
 */
function parseComponents($: CheerioAPI): SummaryComponent[] {
  const components: SummaryComponent[] = [];

  $('table.subFormulario').each((_, table) => {
    const $table = $(table);
    const termMatch = $table.closest('div[id^="semestre"]').attr('id')?.match(/semestre(\d+)/);
    const term = termMatch ? Number(termMatch[1]) : null;

    $table.find('tr').each((_, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      if (cells.length < 2) return;

      const rowMatch = $(cells[0]).text().trim().match(COMPONENT_ROW_PATTERN);
      if (!rowMatch) return;
      const natureText = normalizeLabel($(cells[1]).text());
      const nature: CatalogNature = natureText.startsWith('obrigat')
        ? 'REQUIRED'
        : natureText.startsWith('optat')
          ? 'ELECTIVE'
          : 'COMPLEMENTARY';

      const onclick = $row.find('a[title="Visualizar Detalhes do Componente"]').attr('onclick') ?? '';
      const jsfParams: Record<string, string> = {};
      for (const match of onclick.matchAll(JSF_PARAM_PATTERN)) jsfParams[match[1]] = match[2];
      const sigaaId = jsfParams.id;
      if (!sigaaId) return;

      components.push({
        sigaaId,
        code: rowMatch[1],
        name: rowMatch[2],
        hours: Number(rowMatch[3]),
        nature,
        term,
        jsfParams,
      });
    });
  });

  return components;
}

function parseFormFields($: CheerioAPI): Record<string, string> {
  const formFields: Record<string, string> = {};
  $('form input[type="hidden"]').each((_, input) => {
    const name = $(input).attr('name');
    const value = $(input).attr('value');
    if (name && value !== undefined && name !== VIEW_STATE_FIELD) formFields[name] = value;
  });
  return formFields;
}

export function parseCurriculumSummary(html: string): CurriculumSummary {
  const $ = cheerio.load(html);
  return { ...parseStats($), components: parseComponents($), formFields: parseFormFields($) };
}
