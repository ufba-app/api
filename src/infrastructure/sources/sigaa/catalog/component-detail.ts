import * as cheerio from 'cheerio';

export interface ComponentDetail {
  responsibleUnit: string | null;
  /** Expressão como o SIGAA escreve: "( FISD36 E FISD42 ) OU ( ENGJ18 )". Interpretada no domínio. */
  prerequisite: string | null;
  corequisite: string | null;
  equivalences: string | null;
}

/**
 * O que a página diz que está descrevendo, junto com o detalhe. Fica fora de `ComponentDetail` (o que se grava, onde o
 * código já vem da linha da matriz): é um campo de verificação, lido de volta para o chamador distinguir uma resposta
 * que descreve OUTRO componente da que ele pediu.
 */
export interface ComponentDetailPage extends ComponentDetail {
  code: string | null;
}

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

/** O SIGAA imprime "-" para pré-requisito, co-requisito ou equivalências vazios: não é para gravar o texto "-". */
function valueOrNull(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' || normalized === '-' ? null : normalized;
}

/**
 * `table.visualizacao` tem o mesmo formato th/td da estrutura. Pré-requisito e equivalências envolvem cada código em um
 * `<ACRONYM>`, que o `.text()` já achata.
 */
export function parseComponentDetail(html: string): ComponentDetailPage {
  const $ = cheerio.load(html);
  const detail: ComponentDetailPage = {
    code: null,
    responsibleUnit: null,
    prerequisite: null,
    corequisite: null,
    equivalences: null,
  };

  $('table.visualizacao tr').each((_, row) => {
    const $row = $(row);
    // `children`, não `find`: a página aninha uma tabela "Currículos" inteira numa linha desta, e o cabeçalho dela tem o
    // próprio `<th>Código</th>`, que uma busca profunda leria como rótulo desta linha.
    const th = $row.children('th').first();
    const td = $row.children('td').first();
    if (!th.length || !td.length) return;
    const label = normalizeLabel(th.text());
    const value = valueOrNull(td.text());

    if (label === 'codigo') detail.code = value;
    else if (label === 'unidade responsavel') detail.responsibleUnit = value;
    else if (label === 'pre-requisitos') detail.prerequisite = value;
    else if (label === 'co-requisitos') detail.corequisite = value;
    else if (label === 'equivalencias') detail.equivalences = value;
  });

  return detail;
}
