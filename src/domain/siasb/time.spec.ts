import { parseSiasbDateTime } from './time';

describe('parseSiasbDateTime', () => {
  it('sem offset vale horário da Bahia (-03:00)', () => {
    expect(parseSiasbDateTime('2026-11-20T08:00').toISOString()).toBe('2026-11-20T11:00:00.000Z');
  });

  it('com offset explícito dá o mesmo instante', () => {
    expect(parseSiasbDateTime('2026-11-20T08:00:00-03:00').toISOString()).toBe('2026-11-20T11:00:00.000Z');
  });

  it('texto inválido lança Error', () => {
    expect(() => parseSiasbDateTime('amanhã cedo')).toThrow(Error);
  });
});
