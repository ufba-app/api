import * as cheerio from 'cheerio';
import { assertPaginaDaTurmaVirtual } from './ava-page';
import { lerJsfcljs } from './jsfcljs';

export interface PostbackMenu {
  /** Path do `action` do `formMenu` (sem `;jsessionid` nem query). */
  action: string;
  fields: Record<string, string>;
}

export interface FrequenciaPagina {
  presentClasses: number;
  recordedClasses: number;
  workloadClasses: number;
  /** `false` quando a página traz o aviso "A frequência ainda não foi lançada." */
  complete: boolean;
}

/**
 * Campos do clique em "Frequência" (grupo "Alunos") no `form#formMenu` da turma. `mapa.jsf` NÃO abre por GET direto
 * ("Comportamento Inesperado!"): só por este postback, cuja resposta o SIGAA redireciona para `mapa.jsf`. O nome
 * `j_id_jsp_…` muda por deploy, por isso o link é achado pelo texto. O `javax.faces.ViewState` fica de fora (a sessão
 * manda o da última página).
 */
export function parsePostbackFrequencia(turmaHtml: string): PostbackMenu {
  assertPaginaDaTurmaVirtual(turmaHtml, 'o menu da turma');
  const $ = cheerio.load(turmaHtml);
  const link = $('form#formMenu a')
    .filter((_, a) => $(a).find('.itemMenu').text().trim() === 'Frequência')
    .first();
  const clique = lerJsfcljs(link.attr('onclick') ?? '');
  if (!link.length || !clique) {
    throw new Error('O link "Frequência" não está no menu da turma (form#formMenu)');
  }

  const $form = $('form#formMenu');
  const action = ($form.attr('action') ?? '').split(';')[0].split('?')[0];
  if (!action.startsWith('/sigaa/')) throw new Error('action inesperada no form formMenu');

  const fields: Record<string, string> = {};
  $form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name && name !== 'javax.faces.ViewState') fields[name] = $(el).attr('value') ?? '';
  });
  return { action, fields: { ...fields, ...clique.params } };
}

/** Número que segue o `<b>` com esse rótulo (ex.: "Presenças Registradas:" 29). */
function numeroDoRotulo($: cheerio.CheerioAPI, rotulo: string): number {
  const b = $('fieldset b')
    .filter((_, el) => $(el).text().trim() === rotulo)
    .first();
  if (!b.length) throw new Error(`O mapa de frequência não traz "${rotulo}"`);
  const texto = b.parent().text();
  const depois = texto.slice(texto.indexOf(rotulo) + rotulo.length);
  const m = /^\s*(\d+)/.exec(depois);
  if (!m) throw new Error(`O mapa de frequência não traz um número depois de "${rotulo}"`);
  return Number(m[1]);
}

/**
 * Lê o fieldset "Mapa de Frequências" (`FrequenciaAluno/mapa.jsf`). São **aulas** (55 min), não horas, e a página só
 * traz presenças: a falta é `aulas registradas − presenças`. Número ausente é erro, nunca zero.
 */
export function parseFrequencia(html: string): FrequenciaPagina {
  assertPaginaDaTurmaVirtual(html, 'o mapa de frequência');
  const $ = cheerio.load(html);
  const fieldset = $('fieldset')
    .filter((_, el) => $(el).find('legend').text().includes('Mapa de Frequências'))
    .first();
  if (!fieldset.length) throw new Error('O fieldset "Mapa de Frequências" não está na página');

  return {
    presentClasses: numeroDoRotulo($, 'Presenças Registradas:'),
    recordedClasses: numeroDoRotulo($, 'Número de Aulas com Registro de Frequência:'),
    workloadClasses: numeroDoRotulo($, 'Número de Aulas definidas pela CH do Componente:'),
    complete: !/ainda não foi lançada/i.test(fieldset.text()),
  };
}
