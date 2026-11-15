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
