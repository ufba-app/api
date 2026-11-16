import { bahiaDateKey, bahiaDayAndHour, bahiaWeekday } from './alert-format';

describe('alert-format (horário da Bahia)', () => {
  it('dia e hora cheia: "sexta, 20/11, às 10h"', () => {
    expect(bahiaDayAndHour(new Date('2026-11-20T10:00:00-03:00'))).toBe('sexta, 20/11, às 10h');
  });

  it('com minutos: "às 10h30"; minuto de um dígito ganha zero', () => {
    expect(bahiaDayAndHour(new Date('2026-11-20T10:30:00-03:00'))).toBe('sexta, 20/11, às 10h30');
    expect(bahiaDayAndHour(new Date('2026-11-20T10:05:00-03:00'))).toBe('sexta, 20/11, às 10h05');
  });

  it('usa a Bahia, não o UTC: 01:00 UTC ainda é o dia anterior', () => {
    const d = new Date('2026-11-21T01:00:00Z');
    expect(bahiaDayAndHour(d)).toBe('sexta, 20/11, às 22h');
    expect(bahiaDateKey(d)).toBe('2026-11-20');
  });

  it('nomes dos dias da semana, sem "-feira"', () => {
    expect(bahiaWeekday(new Date('2026-11-15T12:00:00-03:00'))).toBe('domingo');
    expect(bahiaWeekday(new Date('2026-11-16T12:00:00-03:00'))).toBe('segunda');
    expect(bahiaWeekday(new Date('2026-11-17T12:00:00-03:00'))).toBe('terça');
    expect(bahiaWeekday(new Date('2026-11-18T12:00:00-03:00'))).toBe('quarta');
    expect(bahiaWeekday(new Date('2026-11-19T12:00:00-03:00'))).toBe('quinta');
    expect(bahiaWeekday(new Date('2026-11-20T12:00:00-03:00'))).toBe('sexta');
    expect(bahiaWeekday(new Date('2026-11-21T12:00:00-03:00'))).toBe('sábado');
  });

  it('meia-noite da Bahia: 0h e dia do próprio dia', () => {
    const d = new Date('2026-01-05T00:00:00-03:00');
    expect(bahiaDayAndHour(d)).toBe('segunda, 05/01, às 0h');
    expect(bahiaDateKey(d)).toBe('2026-01-05');
  });
});
