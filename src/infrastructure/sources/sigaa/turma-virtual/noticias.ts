import * as cheerio from 'cheerio';
import { assertPaginaDaTurmaVirtual } from './ava-page';
import { lerJsfcljs } from './jsfcljs';

export interface NoticiaResumo {
  id: string;
  titulo: string;
  data: string;
}

const ID_PATTERN = /'id'\s*:\s*'(\d+)'/;

/**
 * Parses `NoticiaTurma/listar.jsf`'s `table.listing`. Uma lista vazia com o
 * marcador de identidade presente é resposta válida ("nada postado ainda"); a
 * ausência do marcador é erro (ver ava-page.ts).
 *
 * O seletor não passa por `tbody` de propósito: cheerio/htmlparser2 não
 * insere o elemento implícito como o browser faz, então exigi-lo devolveria
 * `[]` num SIGAA que o omitisse. A linha de cabeçalho não atrapalha — seus
 * `<th>` não casam com `td`, e a guarda de contagem de células a descarta.
 */
export function parseNoticias(html: string): NoticiaResumo[] {
  assertPaginaDaTurmaVirtual(html, 'a lista de notícias');
  const $ = cheerio.load(html);
  const noticias: NoticiaResumo[] = [];

  $('table.listing tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) {
      return;
    }
    const onclick = $(cells[2]).find('a').attr('onclick') ?? '';
    const match = ID_PATTERN.exec(onclick);
    if (!match) {
      return;
    }
    noticias.push({
      id: match[1],
      titulo: $(cells[0]).text().trim(),
      data: $(cells[1]).text().trim(),
    });
  });

  return noticias;
}

export interface PostbackNoticia {
  /** Path do `action` do form (sem `;jsessionid`); `null` quando a página não traz o form (usar a própria lista). */
  action: string | null;
  fields: Record<string, string>;
}

/**
 * Campos do clique "Visualizar" de UMA notícia em `NoticiaTurma/listar.jsf`: o `jsfcljs` submete o form da lista
 * com o id do link e o `id` da notícia, e a resposta é a notícia. É o único jeito: POST direto em `mostrar.jsf`
 * com só o `id` volta sem a notícia. O `javax.faces.ViewState` fica de fora (a sessão manda o da última página).
 */
export function parsePostbackNoticia(html: string, id: string): PostbackNoticia {
  assertPaginaDaTurmaVirtual(html, 'a lista de notícias');
  const $ = cheerio.load(html);
  let achado: { form: string; params: Record<string, string> } | null = null;
  $('a[onclick]').each((_, a) => {
    const clique = lerJsfcljs($(a).attr('onclick') ?? '');
    if (clique?.params.id === id) {
      achado = clique;
      return false;
    }
  });
  if (!achado) throw new Error(`A notícia ${id} não está na lista de notícias da turma`);
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
