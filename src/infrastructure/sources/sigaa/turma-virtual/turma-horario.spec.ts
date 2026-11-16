import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandClass } from '../../../../domain/academic/class-schedule';
import { parseTurmaVirtualTokens } from './turma-virtual-tokens';
import { parseTurmasHorario } from './turma-horario';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
const portal = fixture('portal-discente-turma-virtual.html'); // HTML simplificado (sala e horário em colunas)
const real = fixture('portal-discente-turmas.html'); // portal REAL (fixture do app antigo): cabeçalho de semestre, td.descricao/td.info

describe('parseTurmasHorario: fixture simplificada do portal', () => {
  it('lê nome, local, código de horário e período de TODAS as linhas, inclusive a turma sem Turma Virtual', () => {
    const turmas = parseTurmasHorario(portal);
    expect(turmas.map((t) => [t.name, t.code])).toEqual([
      ['SISTEMAS OPERACIONAIS', '35T45 (18/08/2026 - 19/12/2026)'],
      ['VISÃO COMPUTACIONAL', '24M12 (18/08/2026 - 19/12/2026)'],
      ['LABORATÓRIO INTEGRADO III-A', '6N12 (18/08/2026 - 19/12/2026)'],
    ]);
    expect(turmas[0].blocks).toEqual([{ weekdays: [3, 5], shift: 'T', modules: [4, 5], invalidModules: [] }]);
    expect(turmas[0].period).toEqual({ start: '2026-08-18', end: '2026-12-19' });
    // Local sem padrão conhecido ("Sala 12"): o texto original, por dia.
    expect(turmas[0].placeByWeekday).toEqual({ 3: 'Sala 12', 5: 'Sala 12' });
  });

  it('o parser de tokens omite a turma sem Turma Virtual; o de horário a inclui (é a diferença que importa)', () => {
    expect(parseTurmaVirtualTokens(portal)).toHaveLength(2);
    expect(parseTurmasHorario(portal)).toHaveLength(3);
  });

  it('linha sem código de horário reconhecível não vira turma (nada é inventado)', () => {
    const html = `<table><tr><td><a>SEM HORARIO</a></td><td>Sala 1</td><td>A definir</td></tr><tr><td><span>COM</span></td><td>Sala 2</td><td>2M12 (01/11/2026 - 30/11/2026)</td></tr></table>`;
    expect(parseTurmasHorario(html).map((t) => t.name)).toEqual(['COM']);
  });

  it('sem coluna de local: place ausente; vários códigos no horário', () => {
    const html = `<table><tr><td><span>DUAS AULAS</span></td><td>24M12 6T12 (01/11/2026 - 30/11/2026)</td></tr></table>`;
    const [t] = parseTurmasHorario(html);
    expect(t.blocks).toHaveLength(2);
    expect(Object.values(t.placeByWeekday).every((p) => p === null)).toBe(true);
  });

  it('página sem tabela de turmas: lista vazia, sem lançar', () => {
    expect(parseTurmasHorario('<html><body>Bem-vindo</body></html>')).toEqual([]);
    expect(parseTurmasHorario('')).toEqual([]);
  });

  it('nunca devolve o HTML nem o token da Turma Virtual', () => {
    for (const html of [portal, real]) {
      expect(JSON.stringify(parseTurmasHorario(html))).not.toMatch(/frontEndIdTurma|AAAA1111|jsfcljs|ViewState/);
    }
  });
});

describe('parseTurmasHorario: portal REAL (fixture do app antigo)', () => {
  const turmas = parseTurmasHorario(real);
  const by = (name: string) => turmas.find((t) => t.name === name)!;

  it('lê as 5 linhas e marca todas com o semestre do cabeçalho ("2026.2", linha de uma célula só)', () => {
    expect(turmas.map((t) => t.name)).toEqual([
      'LABORATÓRIO INTEGRADO III-A',
      'SISTEMAS OPERACIONAIS',
      'PROJETO DE CIRCUITOS INTEGRADOS DIGITAIS',
      'REDES DE COMPUTADORES I',
      'VISÃO COMPUTACIONAL',
    ]);
    expect(turmas.every((t) => t.semester === '2026.2')).toBe(true);
    expect(turmas.every((t) => t.courseCode === null)).toBe(true); // o portal real traz só o nome
  });

  it('período da turma, do fim da célula do horário (19/08/2026 - 19/12/2026)', () => {
    expect(turmas.every((t) => t.period?.start === '2026-08-19' && t.period?.end === '2026-12-19')).toBe(true);
  });

  it('VÁRIOS códigos na mesma célula dividem um período só: "2N12 4N34" = segunda 18:30–20:20 e quarta 20:20–22:10', () => {
    const t = by('PROJETO DE CIRCUITOS INTEGRADOS DIGITAIS');
    expect(t.blocks).toEqual([
      { weekdays: [2], shift: 'N', modules: [1, 2], invalidModules: [] },
      { weekdays: [4], shift: 'N', modules: [3, 4], invalidModules: [] },
    ]);
    expect(t.period).toEqual({ start: '2026-08-19', end: '2026-12-19' });
  });

  it('o horário bate com o que o próprio portal imprime na coluna Local (confirma a tabela de módulos)', () => {
    // 35N12 → o portal diz "Terça Horários 18:30 às 19:25", "Quinta Horários 18:30 às 19:25": N1 = 18:30–19:25 (55 min).
    // 24T56 → o portal diz "Segunda Horários 16:40 às 17:35": T5 = 16:40–17:35 (13:00 + 4×55 min).
    expect(by('SISTEMAS OPERACIONAIS').blocks).toEqual([{ weekdays: [3, 5], shift: 'N', modules: [1, 2], invalidModules: [] }]);
    expect(by('VISÃO COMPUTACIONAL').blocks).toEqual([{ weekdays: [2, 4], shift: 'T', modules: [5, 6], invalidModules: [] }]);
  });

  it('o local vem por dia, em texto curto: prédio fixo e sala repetidos, só prédio, e sala diferente por dia', () => {
    expect(by('SISTEMAS OPERACIONAIS').placeByWeekday).toEqual({ 3: 'PAF 1 · 208', 5: 'PAF 1 · 208' });
    expect(by('LABORATÓRIO INTEGRADO III-A').placeByWeekday).toEqual({ 2: 'ENG' });
    expect(by('PROJETO DE CIRCUITOS INTEGRADOS DIGITAIS').placeByWeekday).toEqual({ 2: 'ENG · 7.1.5', 4: 'ENG · 7.1.5' });
    expect(by('REDES DE COMPUTADORES I').placeByWeekday).toEqual({ 3: 'PAF I', 5: 'PAF II · Smart Class III' }); // terça e quinta em salas diferentes
    expect(by('VISÃO COMPUTACIONAL').placeByWeekday).toEqual({ 2: 'ENG · 7.1.3', 4: 'ENG · 7.1.3' });
  });

  it('nunca devolve o texto cru e comprido do Local quando o padrão é conhecido', () => {
    const out = JSON.stringify(turmas.map((t) => t.placeByWeekday));
    expect(out).not.toMatch(/Horários|às \d/);
  });
});

describe('parseTurmasHorario: código do componente no nome', () => {
  it('"ENGG54 - Nome" separa o código; sem esse formato o nome fica inteiro', () => {
    const html = `<table><tbody>
      <tr><td colspan="5">2026.2</td></tr>
      <tr><td class="descricao"><a>ENGG54 - SISTEMAS OPERACIONAIS</a></td><td class="info">ENG (ENG)</td><td class="info">35T45 (19/08/2026 - 19/12/2026)</td></tr>
      <tr><td class="descricao"><a>MATA52 SEM TRACO</a></td><td class="info">ENG (ENG)</td><td class="info">2M12 (19/08/2026 - 19/12/2026)</td></tr>
    </tbody></table>`;
    const [a, b] = parseTurmasHorario(html);
    expect([a.courseCode, a.name]).toEqual(['ENGG54', 'SISTEMAS OPERACIONAIS']);
    expect([b.courseCode, b.name]).toEqual([null, 'MATA52 SEM TRACO']);
  });

  it('cabeçalho de semestre novo vale para as linhas seguintes; linha antes de qualquer cabeçalho fica sem semestre', () => {
    const html = `<table><tbody>
      <tr><td class="descricao"><a>A</a></td><td class="info">x</td><td class="info">2M12 (01/01/2026 - 30/06/2026)</td></tr>
      <tr><td colspan="5">2026.1</td></tr>
      <tr><td class="descricao"><a>B</a></td><td class="info">x</td><td class="info">3M12 (01/01/2026 - 30/06/2026)</td></tr>
      <tr><td colspan="5">2026.2</td></tr>
      <tr><td class="descricao"><a>C</a></td><td class="info">x</td><td class="info">4M12 (01/08/2026 - 19/12/2026)</td></tr>
    </tbody></table>`;
    expect(parseTurmasHorario(html).map((t) => [t.name, t.semester])).toEqual([['A', null], ['B', '2026.1'], ['C', '2026.2']]);
  });
});

describe('portal REAL: de ponta a ponta até as aulas da semana (parser + expansão)', () => {
  it('semana de 16 a 22/11/2026: dia, faixa de horário e local de cada aula, com a quinta de REDES em outra sala', () => {
    const semana = parseTurmasHorario(real).flatMap((t) =>
      expandClass(t, '2026-11-16', '2026-11-22', () => false).map((o) => `${o.date} ${o.start}-${o.end} ${t.name} @ ${t.placeByWeekday[o.weekday]}`),
    );
    expect(semana.sort()).toEqual([
      '2026-11-16 16:40-18:30 VISÃO COMPUTACIONAL @ ENG · 7.1.3', // 24T56 segunda
      '2026-11-16 18:30-20:20 PROJETO DE CIRCUITOS INTEGRADOS DIGITAIS @ ENG · 7.1.5', // 2N12 segunda
      '2026-11-16 20:20-22:10 LABORATÓRIO INTEGRADO III-A @ ENG', // 2N34 segunda
      '2026-11-17 18:30-20:20 SISTEMAS OPERACIONAIS @ PAF 1 · 208', // 35N12 terça
      '2026-11-17 20:20-22:10 REDES DE COMPUTADORES I @ PAF I', // 35N34 terça
      '2026-11-18 16:40-18:30 VISÃO COMPUTACIONAL @ ENG · 7.1.3', // 24T56 quarta
      '2026-11-18 20:20-22:10 PROJETO DE CIRCUITOS INTEGRADOS DIGITAIS @ ENG · 7.1.5', // 4N34 quarta
      '2026-11-19 18:30-20:20 SISTEMAS OPERACIONAIS @ PAF 1 · 208', // 35N12 quinta
      '2026-11-19 20:20-22:10 REDES DE COMPUTADORES I @ PAF II · Smart Class III', // 35N34 quinta
    ]);
  });
});
