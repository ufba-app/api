import { buildCurriculumGraph } from './curriculum-graph';
import type { CurriculumComponentInput } from './progress';

const comp = (code: string, extra: Partial<CurriculumComponentInput> = {}): CurriculumComponentInput => ({
  code,
  name: code,
  hours: 60,
  nature: 'REQUIRED',
  term: 1,
  prerequisiteExpr: null,
  corequisiteExpr: null,
  equivalenceExpr: null,
  ...extra,
});

const strengthOf = (g: ReturnType<typeof buildCurriculumGraph>, from: string, to: string) =>
  g.edges.find((e) => e.from === from && e.to === to && e.relation === 'PREREQUISITE')?.strength;

describe('buildCurriculumGraph', () => {
  it('um código, ou E: todos obrigatórios', () => {
    const g = buildCurriculumGraph([comp('AAA1'), comp('BBB2'), comp('CCC3', { prerequisiteExpr: '( AAA1 E BBB2 )' })]);
    expect(strengthOf(g, 'AAA1', 'CCC3')).toBe('REQUIRED');
    expect(strengthOf(g, 'BBB2', 'CCC3')).toBe('REQUIRED');
  });

  it('OU: cada alternativa é ALTERNATIVE', () => {
    const g = buildCurriculumGraph([comp('CCC3', { prerequisiteExpr: '( AAA1 ) OU ( BBB2 )' })]);
    expect(strengthOf(g, 'AAA1', 'CCC3')).toBe('ALTERNATIVE');
    expect(strengthOf(g, 'BBB2', 'CCC3')).toBe('ALTERNATIVE');
  });

  it('código presente em todas as alternativas é obrigatório', () => {
    // ( A E B ) OU ( A E C ): A sempre, B ou C
    const g = buildCurriculumGraph([comp('ZZZ9', { prerequisiteExpr: '( AAA1 E BBB2 ) OU ( AAA1 E CCC3 )' })]);
    expect(strengthOf(g, 'AAA1', 'ZZZ9')).toBe('REQUIRED');
    expect(strengthOf(g, 'BBB2', 'ZZZ9')).toBe('ALTERNATIVE');
    expect(strengthOf(g, 'CCC3', 'ZZZ9')).toBe('ALTERNATIVE');
  });

  it('parênteses aninhados (caso real do ENG295)', () => {
    const expr = '( FISD36 E FISD42 E QUI037 ) OU ( ENGJ18 ) OU ( FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) ) )';
    const g = buildCurriculumGraph([comp('ENG295', { prerequisiteExpr: expr })]);
    // nenhum código está em todas as alternativas
    expect(g.incoming('ENG295', 'PREREQUISITE').every((e) => e.strength === 'ALTERNATIVE')).toBe(true);
    expect(g.incoming('ENG295', 'PREREQUISITE').map((e) => e.from)).toEqual(['FISD36', 'FISD42', 'QUI037', 'ENGJ18', 'FISD34', 'QUIA27', 'FISD41', 'QUI029']);
  });

  it('dentro de uma alternativa, E com OU aninhado: o que é comum a ambos os lados do OU é obrigatório', () => {
    const g = buildCurriculumGraph([comp('ZZZ9', { prerequisiteExpr: '( AAA1 E ( BBB2 OU CCC3 ) )' })]);
    expect(strengthOf(g, 'AAA1', 'ZZZ9')).toBe('REQUIRED');
    expect(strengthOf(g, 'BBB2', 'ZZZ9')).toBe('ALTERNATIVE');
  });

  it('libera: quem cita o código no pré-requisito (e só nele)', () => {
    const g = buildCurriculumGraph([
      comp('AAA1'),
      comp('BBB2', { prerequisiteExpr: '( AAA1 )' }),
      comp('CCC3', { prerequisiteExpr: '( AAA1 ) OU ( BBB2 )' }),
      comp('DDD4', { corequisiteExpr: '( AAA1 )' }),
    ]);
    expect(g.unlocks('AAA1').sort()).toEqual(['BBB2', 'CCC3']);
    expect(g.outgoing('AAA1', 'COREQUISITE').map((e) => e.to)).toEqual(['DDD4']);
    expect(g.unlocks('DDD4')).toEqual([]);
  });

  it('co-requisito e equivalência viram arestas de relação própria; a equivalência aceita código fora do currículo', () => {
    const g = buildCurriculumGraph([comp('NEW10', { equivalenceExpr: '( OLD55 OU OLD56 )', corequisiteExpr: '( LAB01 )' })]);
    expect(g.incoming('NEW10', 'EQUIVALENCE').map((e) => [e.from, e.strength])).toEqual([
      ['OLD55', 'ALTERNATIVE'],
      ['OLD56', 'ALTERNATIVE'],
    ]);
    expect(g.incoming('NEW10', 'COREQUISITE').map((e) => [e.from, e.strength])).toEqual([['LAB01', 'REQUIRED']]);
    expect(g.components.has('OLD55')).toBe(false);
  });

  it('expressão sem código (carga mínima) ou malformada não vira aresta e fica em `unparsed`', () => {
    const g = buildCurriculumGraph([
      comp('AAA1', { prerequisiteExpr: 'CH MINIMA 1200' }),
      comp('BBB2', { prerequisiteExpr: '( AAA1 E' }),
      comp('CCC3', { prerequisiteExpr: '( AAA1 )' }),
    ]);
    expect(g.edges.map((e) => e.to)).toEqual(['CCC3']);
    expect(g.unparsed.map((u) => [u.code, u.relation])).toEqual([
      ['AAA1', 'PREREQUISITE'],
      ['BBB2', 'PREREQUISITE'],
    ]);
  });

  it('expressão vazia ou nula não gera nada; matéria que cita a si mesma não cria laço', () => {
    const g = buildCurriculumGraph([comp('AAA1', { prerequisiteExpr: '   ' }), comp('BBB2', { prerequisiteExpr: '( BBB2 E AAA1 )' })]);
    expect(g.unparsed).toEqual([]);
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([['AAA1', 'BBB2']]);
  });
});

describe('CurriculumGraph.prerequisiteEdges', () => {
  it('só pré-requisito entre componentes do currículo, com o tipo da ligação', () => {
    const g = buildCurriculumGraph([
      comp('AAA1'),
      comp('BBB2', { prerequisiteExpr: '( AAA1 )', corequisiteExpr: '( AAA1 )' }),
      comp('CCC3', { prerequisiteExpr: '( AAA1 ) OU ( OLD99 )', equivalenceExpr: '( OLD55 )' }),
    ]);
    expect(g.prerequisiteEdges()).toEqual([
      { from: 'AAA1', to: 'BBB2', kind: 'REQUIRED' },
      { from: 'AAA1', to: 'CCC3', kind: 'ALTERNATIVE' },
    ]);
  });

  it('currículo sem pré-requisitos legíveis: lista vazia', () => {
    expect(buildCurriculumGraph([comp('AAA1', { prerequisiteExpr: 'CH mínima 1500h' })]).prerequisiteEdges()).toEqual([]);
  });
});
