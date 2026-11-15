import { checkExpression, citedCodes, isExpressionMet } from './prerequisite';

const done = (...codes: string[]) => new Set(codes);

describe('citedCodes', () => {
  it('lista os códigos citados, sem repetir', () => {
    expect(citedCodes('( FISD36 E FISD42 E QUI037 ) OU ( ENGJ18 ) OU ( FISD36 )')).toEqual(['FISD36', 'FISD42', 'QUI037', 'ENGJ18']);
    expect(citedCodes('( ENG295A ) OU ( ENG295B )')).toEqual(['ENG295A', 'ENG295B']);
  });
  it('vazio ou nulo não cita nada', () => {
    expect(citedCodes(null)).toEqual([]);
    expect(citedCodes('')).toEqual([]);
  });
});

describe('checkExpression', () => {
  it('sem expressão: atendida', () => {
    expect(checkExpression(null, done())).toBe('MET');
    expect(checkExpression('   ', done())).toBe('MET');
  });

  it('um código: atendido só se cumprido', () => {
    expect(checkExpression('( FISD36 )', done('FISD36'))).toBe('MET');
    expect(checkExpression('( FISD36 )', done('OUTRO1'))).toBe('NOT_MET');
  });

  it('E exige todos; OU basta um', () => {
    const expr = '( FISD36 E FISD42 ) OU ( ENGJ18 )';
    expect(checkExpression(expr, done('FISD36', 'FISD42'))).toBe('MET');
    expect(checkExpression(expr, done('FISD36'))).toBe('NOT_MET');
    expect(checkExpression(expr, done('ENGJ18'))).toBe('MET');
  });

  it('E tem precedência sobre OU (sem parênteses)', () => {
    // A OU B E C  =  A OU (B E C)
    expect(checkExpression('AAA1 OU BBB2 E CCC3', done('AAA1'))).toBe('MET');
    expect(checkExpression('AAA1 OU BBB2 E CCC3', done('BBB2'))).toBe('NOT_MET');
    expect(checkExpression('AAA1 OU BBB2 E CCC3', done('BBB2', 'CCC3'))).toBe('MET');
  });

  it('parênteses aninhados (caso real do ENG295)', () => {
    const expr = '( FISD36 E FISD42 E QUI037 ) OU ( ENGJ18 ) OU ( FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) ) )';
    expect(checkExpression(expr, done('FISD34', 'FISD41', 'QUI029'))).toBe('MET');
    expect(checkExpression(expr, done('FISD34', 'QUIA27'))).toBe('MET');
    expect(checkExpression(expr, done('FISD34'))).toBe('NOT_MET');
  });

  it('expressões reais do SIGAA (importação de 15/11/2026): parênteses duplos e código com 4 letras e 4 dígitos', () => {
    // FISD34: o pré-requisito tem um OU com um termo entre parênteses duplos
    const prereq = '( FISD36 E FISD42 ) OU ( MATA01 E MATA02 E FISD36 E FISD42 ) OU ( FISD36 E FISD42 E MATA02 ) OU ( ( FISD36 E MATA03 ) )';
    expect(checkExpression(prereq, done('FISD36', 'FISD42'))).toBe('MET');
    expect(checkExpression(prereq, done('FISD36', 'MATA03'))).toBe('MET');
    expect(checkExpression(prereq, done('FISD36'))).toBe('NOT_MET');
    expect(citedCodes(prereq)).toEqual(['FISD36', 'FISD42', 'MATA01', 'MATA02', 'MATA03']);
    // equivalência com OU dentro de parênteses duplos
    const equiv = '( ( FIS122A OU FIS122 ) ) OU ( FISD34A ) OU ( FIS011B OU FIS011A OU FIS011 )';
    expect(checkExpression(equiv, done('FIS122'))).toBe('MET');
    expect(checkExpression(equiv, done('FIS011A'))).toBe('MET');
    expect(checkExpression(equiv, done('XYZ1'))).toBe('NOT_MET');
    // ENG295: GENG0091 (quatro letras e quatro dígitos) é um código
    const eng = '( FISD36 E FISD42 E QUI037 ) OU ( GENG0091 ) OU ( FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) ) )';
    expect(checkExpression(eng, done('GENG0091'))).toBe('MET');
    expect(citedCodes(eng)).toContain('GENG0091');
  });

  it('parêntese colado ao código também é lido', () => {
    expect(checkExpression('(FISD36 E FISD42)', done('FISD36', 'FISD42'))).toBe('MET');
  });

  it('sem código reconhecível (ex.: carga mínima) ou malformado: UNKNOWN, nunca atendida', () => {
    expect(checkExpression('CH mínima 1000h', done('FISD36'))).toBe('UNKNOWN');
    expect(checkExpression('( FISD36 E', done('FISD36'))).toBe('UNKNOWN');
    expect(checkExpression('FISD36 E OU FISD42', done('FISD36', 'FISD42'))).toBe('UNKNOWN');
    expect(isExpressionMet('CH mínima 1000h', done('FISD36'))).toBe(false);
  });
});
