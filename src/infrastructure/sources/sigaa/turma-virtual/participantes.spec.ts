import { parseDiscentes, parsePostbackParticipantes } from './participantes';

const CABECALHO = '<form id="formMenu" action="/sigaa/ava/index.jsf"></form><h2>Turma</h2>';

/** Página da turma com o menu: o link "Participantes" é um postback do form `formMenu`. Dados fictícios. */
const MENU = `<form id="formMenu" name="formMenu" method="post" action="/sigaa/ava/index.jsf">
<input type="hidden" name="formMenu" value="formMenu">
<a href="#" onclick="if(typeof jsfcljs == 'function'){jsfcljs(document.getElementById('formMenu'),{'formMenu:j_id_jsp_1_78':'formMenu:j_id_jsp_1_78'},'');}return false">
  <div class="itemMenu">Notícias</div></a>
<a href="#" onclick="if(typeof jsfcljs == 'function'){jsfcljs(document.getElementById('formMenu'),{'formMenu:j_id_jsp_1_83':'formMenu:j_id_jsp_1_83'},'');}return false">
  <div class="itemMenu">Participantes</div></a>
<input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="j_id3">
</form><h2>Turma</h2>`;

const docente = `<fieldset><legend> Docentes (1)</legend></fieldset>
<table class="participantes"><tbody><tr class="odd"><td valign="top">
  <strong><a href="/sigaa/public/RedirectDocente?login=/docente.ficticio">PROFESSORA FICTICIA</a></strong> <br>
  Departamento: <em>DEPARTAMENTO X</em> <br>
  E-Mail: <em>docente@exemplo.test</em> <br>
</td></tr></tbody></table>`;

const discente = (nome: string, matricula: string) => `<tr class="odd"><td width="47"><img src="/sigaa/img/no_picture.png"></td>
<td valign="top"><strong>${nome}</strong><br>
Curso: <em>CURSO FICTICIO</em><br>
Matrícula: <em>${matricula}</em> <br>
E-mail: <em>aluno@exemplo.test</em></td><td width="20"></td></tr>`;

function paginaParticipantes(esperado: number, discentes: string[]): string {
  return `${CABECALHO}${docente}<br>
<fieldset><legend> Discentes (${esperado})</legend></fieldset>
<table class="participantes"><tbody><tr><td colspan="8" class="subFormulario"></td></tr>
${discentes.join('\n')}
</tbody></table>`;
}

describe('participantes da turma (SIGAA)', () => {
  it('acha o link "Participantes" do menu e devolve o postback (form, action e campos)', () => {
    const p = parsePostbackParticipantes(MENU);
    expect(p.action).toBe('/sigaa/ava/index.jsf');
    expect(p.fields).toMatchObject({ formMenu: 'formMenu', 'formMenu:j_id_jsp_1_83': 'formMenu:j_id_jsp_1_83' });
    expect(p.fields['javax.faces.ViewState']).toBeUndefined();
    expect(p.fields['formMenu:j_id_jsp_1_78']).toBeUndefined();
  });

  it('sem o link "Participantes" no menu, erra', () => {
    expect(() => parsePostbackParticipantes(CABECALHO)).toThrow();
  });

  it('lê só os discentes, pelo nome, e deixa o docente de fora', () => {
    const html = paginaParticipantes(3, [
      discente('ALUNA FICTICIA UM', '100000001'),
      discente('ALUNO FICTICIO DOIS', '100000002'),
      discente('ALUNO FICTICIO TRES', '100000003'),
    ]);
    expect(parseDiscentes(html)).toEqual(['ALUNA FICTICIA UM', 'ALUNO FICTICIO DOIS', 'ALUNO FICTICIO TRES']);
  });

  it('não devolve matrícula nem e-mail', () => {
    const html = paginaParticipantes(1, [discente('ALUNA FICTICIA UM', '100000001')]);
    const nomes = parseDiscentes(html);
    expect(JSON.stringify(nomes)).not.toContain('100000001');
    expect(JSON.stringify(nomes)).not.toContain('@');
  });

  it('se a contagem da legenda não bate com os nomes lidos, erra (nunca lista parcial)', () => {
    const html = paginaParticipantes(3, [discente('ALUNA FICTICIA UM', '100000001'), discente('ALUNO FICTICIO DOIS', '100000002')]);
    expect(() => parseDiscentes(html)).toThrow('Lista de discentes incompleta: 2 de 3');
  });

  it('página sem a lista de discentes erra', () => {
    expect(() => parseDiscentes(`${CABECALHO}${docente}`)).toThrow('não tem a lista de discentes');
  });
});
