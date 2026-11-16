import { formatPlace, parseLocation } from './class-location';

/** Casos do `local.spec.ts` do app antigo (texto real do portal), com os dias como números (2 segunda ... 7 sábado). */
describe('parseLocation', () => {
  it('só prédio quando a sala ainda não foi definida ("ENG (ENG)")', () => {
    expect(parseLocation('ENG (ENG)', [2])).toEqual(new Map([[2, { building: 'ENG', room: null, original: 'ENG (ENG)' }]]));
  });

  it('prédio e sala fixos, repetidos por dia/horário', () => {
    const local = 'PAF 1 - 208 - Terça Horários 18:30 às 19:25PAF 1 - 208 - Quinta Horários 18:30 às 19:25PAF 1 - 208 - Quinta Horários 19:25 às 20:20';
    const r = parseLocation(local, [3, 5]);
    expect(r.get(3)).toEqual({ building: 'PAF 1', room: '208', original: local });
    expect(r.get(5)).toEqual({ building: 'PAF 1', room: '208', original: local });
  });

  it('sala com números pontuados ("ENG - 7.1.5")', () => {
    const local = 'ENG - 7.1.5 - Segunda Horários 18:30 às 19:25ENG - 7.1.5 - Segunda Horários 19:25 às 20:20';
    expect(parseLocation(local, [2]).get(2)).toMatchObject({ building: 'ENG', room: '7.1.5' });
  });

  it('local diferente por dia ("Ter PAF I/Qui Smart Class III"); Smart Class é sala do PAF II', () => {
    const r = parseLocation('Ter PAF I/Qui Smart Class III', [3, 5]);
    expect(r.get(3)).toMatchObject({ building: 'PAF I', room: null });
    expect(r.get(5)).toMatchObject({ building: 'PAF II', room: 'Smart Class III' });
  });

  it('Smart Class também é reconhecida no padrão de prédio fixo', () => {
    const local = 'Smart Class III - 12 - Terça Horários 18:30 às 19:25';
    expect(parseLocation(local, [3]).get(3)).toMatchObject({ building: 'PAF II', room: 'Smart Class III' });
  });

  it('dia que falta num padrão por dia parcialmente reconhecido volta ao texto original', () => {
    const r = parseLocation('Ter PAF I/Qui Sala 3', [3, 4]);
    expect(r.get(3)).toMatchObject({ building: 'PAF I' });
    expect(r.get(4)).toEqual({ building: null, room: null, original: 'Ter PAF I/Qui Sala 3' });
  });

  it('sem padrão reconhecido, preserva o texto original (nada se perde)', () => {
    expect(parseLocation('Sala 12', [2, 4]).get(4)).toEqual({ building: null, room: null, original: 'Sala 12' });
  });
});

describe('formatPlace', () => {
  it.each([
    [{ building: 'PAF 1', room: '208', original: 'x' }, 'PAF 1 · 208'],
    [{ building: 'ENG', room: null, original: 'x' }, 'ENG'],
    [{ building: null, room: null, original: '  Sala   12 ' }, 'Sala 12'],
    [{ building: null, room: null, original: '   ' }, null],
  ])('%j → %s', (l, esperado) => expect(formatPlace(l)).toBe(esperado));

  it('texto cru muito comprido é cortado', () => {
    const p = formatPlace({ building: null, room: null, original: 'x'.repeat(300) })!;
    expect(p.length).toBeLessThanOrEqual(80);
    expect(p.endsWith('…')).toBe(true);
  });
});
