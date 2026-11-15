import { deduceSlots, nextSlotStart } from './clinic-slots';
import type { ClinicalSession } from './types';

const ses = (i: number, disciplineId: string, start: string, end: string): ClinicalSession => ({
  id: String(i), attendanceId: 'a', disciplineId, disciplineName: 'x', initials: '', professorName: '', locationName: '',
  startAt: new Date(start), endAt: new Date(end), rescheduledStartAt: null, statusLabel: 'Confirmado',
});

describe('clinic slots', () => {
  const sessions: ClinicalSession[] = [];
  // quartas 08h (2026-01-07 + 7n), 12 vezes; durações 60 min, uma de 90
  for (let n = 0; n < 12; n++) {
    const day = new Date(Date.UTC(2026, 0, 7 + 7 * n)).toISOString().slice(0, 10);
    sessions.push(ses(n, '1', `${day}T08:00:00-03:00`, `${day}T0${n === 0 ? '9:30' : '9:00'}:00-03:00`));
  }
  // segundas 13h, 3 vezes
  for (let n = 0; n < 3; n++) {
    const day = new Date(Date.UTC(2026, 0, 5 + 7 * n)).toISOString().slice(0, 10);
    sessions.push(ses(100 + n, '1', `${day}T13:00:00-03:00`, `${day}T14:00:00-03:00`));
  }

  it('deduz dois slots com mediana', () => {
    const slots = deduceSlots(sessions);
    expect(slots).toHaveLength(2);
    expect(slots).toContainEqual({ disciplineId: '1', weekday: 3, time: '08:00', durationMin: 60 });
    expect(slots).toContainEqual({ disciplineId: '1', weekday: 1, time: '13:00', durationMin: 60 });
  });
  it('sessão isolada não gera slot', () => {
    expect(deduceSlots([ses(1, '2', '2026-01-07T08:00:00-03:00', '2026-01-07T09:00:00-03:00')])).toEqual([]);
  });
  it('disciplina sem sessões: null', () => {
    expect(nextSlotStart(deduceSlots(sessions), '9', new Date('2026-11-16T00:00:00-03:00'))).toBeNull();
  });
  it('próximo slot futuro em horário da Bahia', () => {
    const slots = deduceSlots(sessions);
    // segunda 2026-11-16 12:00 Bahia -> segunda 13h do mesmo dia
    expect(nextSlotStart(slots, '1', new Date('2026-11-16T12:00:00-03:00'))?.toISOString())
      .toBe(new Date('2026-11-16T13:00:00-03:00').toISOString());
    // segunda 14h -> quarta 08h
    expect(nextSlotStart(slots, '1', new Date('2026-11-16T14:00:00-03:00'))?.toISOString())
      .toBe(new Date('2026-11-18T08:00:00-03:00').toISOString());
  });
});
