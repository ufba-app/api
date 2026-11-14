import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNoticias, parsePostbackNoticia } from './noticias';

const FIXTURE_PATH = join(__dirname, '__fixtures__', 'noticias-listar.html');
const FIXTURE_VAZIO_PATH = join(
  __dirname,
  '__fixtures__',
  'noticias-listar-vazio.html',
);

const MENU = '<form id="formMenu" action="/sigaa/ava/index.jsf"></form>';

describe('parseNoticias', () => {
  it('lists id, título and data for each notícia', () => {
    const html = readFileSync(FIXTURE_PATH, 'utf-8');

    expect(parseNoticias(html)).toEqual([
      { id: '6279402', titulo: 'Início do Semestre', data: '18/08/2026' },
    ]);
  });

  it('returns an empty list when the turma simply has no notícias yet', () => {
    const html = readFileSync(FIXTURE_VAZIO_PATH, 'utf-8');

    expect(parseNoticias(html)).toEqual([]);
  });

  // cheerio/htmlparser2 não insere <tbody> como o browser: um SIGAA que
  // omitisse o tbody devolveria [] silenciosamente com o seletor antigo.
  it('parses rows even when the real markup omits <tbody>', () => {
    const html = `${MENU}<table class="listing"><tr><th>Título</th><th>Data</th><th></th></tr><tr><td>Aviso</td><td>19/08/2026</td><td class="icon"><a onclick="jsfcljs(x,{'id':'42'},'')"></a></td></tr></table>`;

    expect(parseNoticias(html)).toEqual([
      { id: '42', titulo: 'Aviso', data: '19/08/2026' },
    ]);
  });

  it('throws when the page is not a Turma Virtual page at all', () => {
    expect(() =>
      parseNoticias('<html><body>home do portal</body></html>'),
    ).toThrow(/formMenu/);
  });
});

/**
 * O SIGAA só mostra a notícia pelo clique "Visualizar" da lista: postback do `formListagem` com o link e o `id`.
 * POST direto em `mostrar.jsf` com só o `id` devolve uma página sem a notícia (visto no SIGAA real em 06/11/2026).
 */
describe('parsePostbackNoticia', () => {
  it('campos do clique da notícia, sem form na página: action padrão (null)', () => {
    const html = readFileSync(FIXTURE_PATH, 'utf-8');
    expect(parsePostbackNoticia(html, '6279402')).toEqual({
      action: null,
      fields: {
        formListagem: 'formListagem',
        'formListagem:j_id_301': 'formListagem:j_id_301',
        id: '6279402',
      },
    });
  });

  it('com o form: action sem jsessionid e campos ocultos, sem o ViewState', () => {
    const html = `${MENU}<form id="formListagem" name="formListagem" method="post" action="/sigaa/ava/NoticiaTurma/listar.jsf;jsessionid=ABC">
<input type="hidden" name="formListagem" value="formListagem" />
<input type="hidden" name="extra" value="1" />
<table class="listing"><tr><td>T</td><td>01/01/2026</td><td class="icon"><a onclick="jsfcljs(document.getElementById('formListagem'),{'formListagem:j_id_9':'formListagem:j_id_9','id':'42'},'')">v</a></td></tr></table>
<input type="hidden" name="javax.faces.ViewState" value="j_id5" />
</form>`;
    expect(parsePostbackNoticia(html, '42')).toEqual({
      action: '/sigaa/ava/NoticiaTurma/listar.jsf',
      fields: { formListagem: 'formListagem', extra: '1', 'formListagem:j_id_9': 'formListagem:j_id_9', id: '42' },
    });
  });

  it('notícia que não está na lista: erro', () => {
    const html = readFileSync(FIXTURE_PATH, 'utf-8');
    expect(() => parsePostbackNoticia(html, '999')).toThrow(/não está na lista/);
  });

  it('action fora do SIGAA: erro', () => {
    const html = `${MENU}<form id="formListagem" action="https://evil.example/x"><a onclick="jsfcljs(document.getElementById('formListagem'),{'formListagem:a':'formListagem:a','id':'1'},'')">v</a></form>`;
    expect(() => parsePostbackNoticia(html, '1')).toThrow(/action/);
  });
});
