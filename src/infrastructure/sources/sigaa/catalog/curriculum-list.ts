import * as cheerio from 'cheerio';

export interface CurriculumListItem {
  /** Código da estrutura curricular ("G20251"). */
  code: string;
  /** O SIGAA marca uma estrutura como "Ativa": é a que vale para todos os alunos do curso. */
  active: boolean;
  /** Parâmetros do `jsfcljs` do link "Visualizar Estrutura Curricular" (inclui o `id` da estrutura). */
  jsfParams: Record<string, string>;
  /**
   * Campos ocultos do formulário que envolve o link (sem o ViewState, que a sessão cuida). Um navegador os envia junto
   * com `jsfParams`; sem o marcador do formulário (`formCurriculosCurso=formCurriculosCurso`) o JSF não sabe que o
   * formulário foi enviado e a ação nunca dispara.
   */
  formFields: Record<string, string>;
}

// "Detalhes da Estrutura Curricular G20251, Criado em  2025"
const CODE_PATTERN = /Estrutura Curricular\s+(\S+),/;
// Todos os pares chave:valor do objeto literal do `jsfcljs({...})` do onclick: só o formato (chaves e valores string, uma
// delas `id`) é garantido, então não se fixa o nome do campo gerado pelo JSF.
const JSF_PARAM_PATTERN = /'([^']+)':'([^']+)'/g;
const VIEW_STATE_FIELD = 'javax.faces.ViewState';

/**
 * `curso/curriculo.jsf` lista todas as estruturas curriculares de um curso, ativas e encerradas, como linhas de
 * `table#table_lt`. O link "Visualizar Estrutura Curricular" é um postback JSF (jsfcljs), não um href.
 */
export function parseCurriculumList(html: string): CurriculumListItem[] {
  const $ = cheerio.load(html);
  const curricula: CurriculumListItem[] = [];

  const formFields: Record<string, string> = {};
  $('form input[type="hidden"]').each((_, input) => {
    const name = $(input).attr('name');
    const value = $(input).attr('value');
    if (name && value !== undefined && name !== VIEW_STATE_FIELD) formFields[name] = value;
  });

  $('table#table_lt tr.linha_par, table#table_lt tr.linha_impar').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (cells.length < 3) return;

    const codeMatch = $(cells[0]).text().match(CODE_PATTERN);
    if (!codeMatch) return;
    const status = $(cells[1]).text().trim();

    const onclick = $(cells[2]).find('a[title="Visualizar Estrutura Curricular"]').attr('onclick') ?? '';
    const jsfParams: Record<string, string> = {};
    for (const match of onclick.matchAll(JSF_PARAM_PATTERN)) jsfParams[match[1]] = match[2];
    if (Object.keys(jsfParams).length === 0) return;

    curricula.push({ code: codeMatch[1], active: status === 'Ativa', jsfParams, formFields });
  });

  return curricula;
}
