import { estimateBookingDeadline } from './deadline';

const d = (s: string) => new Date(s);

describe('estimateBookingDeadline', () => {
  it('sexta 10h vira quarta 10h', () =>
    expect(estimateBookingDeadline(d('2026-11-27T10:00:00-03:00'), []).toISOString()).toBe(d('2026-11-25T10:00:00-03:00').toISOString()));
  it('pula feriado', () =>
    expect(estimateBookingDeadline(d('2026-11-27T10:00:00-03:00'), ['2026-11-25']).toISOString()).toBe(d('2026-11-24T10:00:00-03:00').toISOString()));
  it('segunda vira quinta anterior', () =>
    expect(estimateBookingDeadline(d('2026-11-30T10:00:00-03:00'), []).toISOString()).toBe(d('2026-11-26T10:00:00-03:00').toISOString()));
  it('margem de 1 dia útil: sexta vira terça', () =>
    expect(estimateBookingDeadline(d('2026-11-27T10:00:00-03:00'), [], 1).toISOString()).toBe(d('2026-11-24T10:00:00-03:00').toISOString()));
  it('usa a data local da Bahia, não a UTC (sessão às 22h)', () =>
    expect(estimateBookingDeadline(d('2026-11-27T22:00:00-03:00'), ['2026-11-26']).toISOString()).toBe(d('2026-11-24T22:00:00-03:00').toISOString()));
});
