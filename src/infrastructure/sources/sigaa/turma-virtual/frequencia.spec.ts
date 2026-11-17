import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrequencia, parsePostbackFrequencia } from './frequencia';
import { lerJsfcljs } from './jsfcljs';

const fixture = (nome: string) => readFileSync(join(__dirname, '__fixtures__', nome), 'utf-8');

const MENU = '<form id="formMenu" action="/sigaa/ava/index.jsf"></form>';

describe('parseFrequencia', () => {
  it('lê presenças, aulas registradas e aulas da CH; o aviso vermelho marca complete=false', () => {
    expect(parseFrequencia(fixture('frequencia-mapa.html'))).toEqual({
      presentClasses: 29,
      recordedClasses: 29,
      workloadClasses: 32,
      complete: false,
    });
  });

  it('sem o aviso "ainda não foi lançada": complete=true, com faltas visíveis nos números', () => {
    expect(parseFrequencia(fixture('frequencia-mapa-lancada.html'))).toEqual({
      presentClasses: 21,
      recordedClasses: 29,
      workloadClasses: 32,
      complete: true,
    });
  });

  it('lança quando a página não é da Turma Virtual', () => {
    expect(() => parseFrequencia('<html><body>home do portal</body></html>')).toThrow(/formMenu/);
  });

  it('lança quando falta um dos números (nunca devolve zero no lugar de "não deu para ler")', () => {
    const html = `${MENU}<fieldset><legend>Mapa de Frequências</legend><div class="botoes-show"><span><b>Número de Aulas com Registro de Frequência:</b> 29</span><b>Número de Aulas definidas pela CH do Componente:</b> 32</div></fieldset>`;
    expect(() => parseFrequencia(html)).toThrow(/Presenças Registradas/);
  });

  it('lança quando o fieldset do mapa não existe', () => {
    expect(() => parseFrequencia(`${MENU}<p>outra página da turma</p>`)).toThrow(/Mapa de Frequências/);
  });
});

describe('parsePostbackFrequencia', () => {
  it('monta o postback do item "Frequência" do menu, sem ViewState nem jsessionid', () => {
    expect(parsePostbackFrequencia(fixture('turma-menu.html'))).toEqual({
      action: '/sigaa/ava/index.jsf',
      fields: {
        formMenu: 'formMenu',
        'formMenu:j_id_jsp_1857845999_98': 'formMenu:j_id_jsp_1857845999_98',
      },
    });
  });

  it('lança quando o menu não tem o link "Frequência"', () => {
    expect(() => parsePostbackFrequencia(`${MENU}<a onclick="x"><div class="itemMenu">Ver Grupo</div></a>`)).toThrow(
      /Frequência/,
    );
  });

  it('lança quando a página não é da Turma Virtual', () => {
    expect(() => parsePostbackFrequencia('<html><body>home</body></html>')).toThrow(/formMenu/);
  });

  it('lança quando o action do form sai de /sigaa/', () => {
    const html =
      '<form id="formMenu" action="http://outro.exemplo/x"><a onclick="jsfcljs(document.getElementById(\'formMenu\'),{\'a\':\'b\'},\'\')"><div class="itemMenu">Frequência</div></a></form>';
    expect(() => parsePostbackFrequencia(html)).toThrow(/action/);
  });
});

describe('lerJsfcljs', () => {
  it('devolve o form e os parâmetros do jsfcljs', () => {
    expect(lerJsfcljs("jsfcljs(document.getElementById('f'),{'a':'b','c':'d'},'')")).toEqual({
      form: 'f',
      params: { a: 'b', c: 'd' },
    });
  });

  it('devolve null quando o onclick não tem jsfcljs', () => {
    expect(lerJsfcljs('sem jsfcljs')).toBeNull();
  });
});
