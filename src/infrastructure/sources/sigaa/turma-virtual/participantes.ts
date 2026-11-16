import * as cheerio from 'cheerio';
import { assertPaginaDaTurmaVirtual } from './ava-page';

export interface PostbackParticipantes {
  /** Path do `action` do form do menu (sem `;jsessionid`); `null` quando a página não traz o form. */
  action: string | null;
  fields: Record<string, string>;
}

const JSFCLJS = /jsfcljs\(\s*document\.getElementById\('([^']+)'\)\s*,\s*\{([^}]*)\}/;
const PAR = /'([^']*)'\s*:\s*'([^']*)'/g;

/**
 * Campos do postback do link "Participantes" do menu da turma (grupo "Turma"): o `jsfcljs` submete o form `formMenu`
 * com o id do link. O nome do campo `j_id_jsp_...` muda por deploy, então o link é achado pelo texto do `.itemMenu`.
 */
export function parsePostbackParticipantes(html: string): PostbackParticipantes {
  assertPaginaDaTurmaVirtual(html, 'a página principal da turma');
  const $ = cheerio.load(html);
  let achado: { form: string; params: Record<string, string> } | null = null;
  for (const a of $('a').toArray()) {
    if ($(a).find('.itemMenu').text().trim() !== 'Participantes') continue;
    const m = JSFCLJS.exec($(a).attr('onclick') ?? '');
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [, k, v] of m[2].matchAll(PAR)) params[k] = v;
    achado = { form: m[1], params };
    break;
  }
  if (!achado) throw new Error('O menu da turma não tem o link "Participantes"');
  const { form, params } = achado as { form: string; params: Record<string, string> };

  const $form = $(`form[id="${form}"]`);
  const fields: Record<string, string> = {};
  let action: string | null = null;
  if ($form.length) {
    const raw = ($form.attr('action') ?? '').split(';')[0].split('?')[0];
    if (!raw.startsWith('/sigaa/')) throw new Error(`action inesperada no form ${form}`);
    action = raw;
    $form.find('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      if (name && name !== 'javax.faces.ViewState') fields[name] = $(el).attr('value') ?? '';
    });
  } else {
    fields[form] = form;
  }
  return { action, fields: { ...fields, ...params } };
}

/**
 * Nomes dos DISCENTES da página de participantes (só o nome; o resto da linha, como matrícula e e-mail, não sai daqui).
 * Lê a tabela logo depois da legenda "Discentes (N)" e conta só as células com o rótulo `Matrícula:`. Se o número de nomes
 * não bater com o N da legenda, ou se a lista não existir, erra: nunca devolve lista parcial no lugar de "não deu para ler".
 */
export function parseDiscentes(html: string): string[] {
  assertPaginaDaTurmaVirtual(html, 'a lista de participantes');
  const $ = cheerio.load(html);
  const legenda = $('legend')
    .filter((_, l) => /^\s*Discentes\s*\(\d+\)/.test($(l).text()))
    .first();
  if (!legenda.length) throw new Error('A página de participantes não tem a lista de discentes');
  const esperado = Number(/\((\d+)\)/.exec(legenda.text())![1]);
  const tabela = legenda.closest('fieldset').next('table.participantes');
  if (!tabela.length) throw new Error('A lista de discentes não está na página de participantes');

  const nomes: string[] = [];
  tabela.find('td[valign="top"]').each((_, td) => {
    const $td = $(td);
    if (!/Matrícula:/.test($td.text())) return;
    const nome = $td.find('strong').first().text().replace(/\s+/g, ' ').trim();
    if (nome) nomes.push(nome);
  });
  if (nomes.length !== esperado) {
    throw new Error(`Lista de discentes incompleta: ${nomes.length} de ${esperado}`);
  }
  return nomes;
}
