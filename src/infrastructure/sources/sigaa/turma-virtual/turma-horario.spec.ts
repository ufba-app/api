import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTurmaVirtualTokens } from './turma-virtual-tokens';
import { parseTurmasHorario } from './turma-horario';

const portal = readFileSync(join(__dirname, '__fixtures__', 'portal-discente-turma-virtual.html'), 'utf-8');

describe('parseTurmasHorario (a mesma página do portal que parseTurmaVirtualTokens lê)', () => {
  it('lê nome, sala, código de horário e período de TODAS as linhas, inclusive a turma sem Turma Virtual', () => {
    const turmas = parseTurmasHorario(portal);
    expect(turmas.map((t) => [t.name, t.room, t.code])).toEqual([
      ['SISTEMAS OPERACIONAIS', 'Sala 12', '35T45 (18/08/2026 - 19/12/2026)'],
      ['VISÃO COMPUTACIONAL', 'Sala 8', '24M12 (18/08/2026 - 19/12/2026)'],
      ['LABORATÓRIO INTEGRADO III-A', 'Sala 3', '6N12 (18/08/2026 - 19/12/2026)'],
    ]);
    expect(turmas[0].blocks).toEqual([{ weekdays: [3, 5], shift: 'T', modules: [4, 5] }]);
    expect(turmas[2].blocks).toEqual([{ weekdays: [6], shift: 'N', modules: [1, 2] }]);
    expect(turmas[0].period).toEqual({ start: '2026-08-18', end: '2026-12-19' });
  });

  it('o parser de tokens omite a turma sem Turma Virtual; o de horário a inclui (é a diferença que importa)', () => {
    expect(parseTurmaVirtualTokens(portal)).toHaveLength(2);
    expect(parseTurmasHorario(portal)).toHaveLength(3);
  });

  it('linha sem código de horário reconhecível não vira turma (nada é inventado)', () => {
    const html = `<table><tr><td><a>SEM HORARIO</a></td><td>Sala 1</td><td>A definir</td></tr><tr><td><span>COM</span></td><td>Sala 2</td><td>2M12 (01/11/2026 - 30/11/2026)</td></tr></table>`;
    expect(parseTurmasHorario(html).map((t) => t.name)).toEqual(['COM']);
  });

  it('sem coluna de sala: room null; vários códigos no horário', () => {
    const html = `<table><tr><td><span>DUAS AULAS</span></td><td>24M12 6T12 (01/11/2026 - 30/11/2026)</td></tr></table>`;
    const [t] = parseTurmasHorario(html);
    expect(t.room).toBeNull();
    expect(t.blocks).toHaveLength(2);
  });

  it('página sem tabela de turmas: lista vazia, sem lançar', () => {
    expect(parseTurmasHorario('<html><body>Bem-vindo</body></html>')).toEqual([]);
    expect(parseTurmasHorario('')).toEqual([]);
  });

  it('nunca devolve o HTML nem o token da Turma Virtual', () => {
    const out = JSON.stringify(parseTurmasHorario(portal));
    expect(out).not.toMatch(/frontEndIdTurma|AAAA1111|jsfcljs|ViewState/);
  });
});
