import { computeStates, isMarked } from './clinical-state';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from './types';

const now = new Date('2026-11-16T12:00:00-03:00');
const disc = (id: string): ClinicalDiscipline => ({ id, name: `D${id}` });
const att = (id: string, disciplineId: string): ClinicalAttendance => ({
  id, disciplineId, firstName: 'Ab', treatmentType: 'PLANNING', concluded: false,
});
const ses = (id: string, attendanceId: string, disciplineId: string, start: string, statusLabel = 'Confirmado'): ClinicalSession => ({
  id, attendanceId, disciplineId, disciplineName: 'x', firstName: 'Ab', professorName: 'p', locationName: 'l',
  startAt: new Date(start), endAt: new Date(start), rescheduledStartAt: null, statusLabel,
});

describe('isMarked', () => {
  it.each(['Confirmado', 'Nova', 'Agendado pelo sistema', 'Solicitação de reagendamento', 'CONFIRMADO'])('%s é marcada', (l) =>
    expect(isMarked(l)).toBe(true));
  it.each(['Desmarcado', 'Cancelada', 'Atendido', 'Falta paciente', 'rótulo-novo'])('%s não é marcada', (l) =>
    expect(isMarked(l)).toBe(false));
});

describe('computeStates', () => {
  const run = (activeAttendances: ClinicalAttendance[], sessions: ClinicalSession[]) =>
    computeStates({ disciplines: [disc('1')], activeAttendances, sessions, now })[0].state;
  const future = '2026-11-20T08:00:00-03:00';

  it('sem atendimento ativo: NO_PATIENT', () => expect(run([], [])).toBe('NO_PATIENT'));
  it('atendimento ativo sem sessão: NO_SESSION', () => expect(run([att('a', '1')], [])).toBe('NO_SESSION'));
  it('sessão futura marcada: SCHEDULED', () =>
    expect(run([att('a', '1')], [ses('s', 'a', '1', future)])).toBe('SCHEDULED'));
  it('sessão de atendimento fora dos ativos não conta', () =>
    expect(run([att('a', '1')], [ses('s', 'outro', '1', future)])).toBe('NO_SESSION'));
  it('sessão passada não conta', () =>
    expect(run([att('a', '1')], [ses('s', 'a', '1', '2026-11-10T08:00:00-03:00')])).toBe('NO_SESSION'));
  it('sessão futura desmarcada não conta', () =>
    expect(run([att('a', '1')], [ses('s', 'a', '1', future, 'Desmarcado')])).toBe('NO_SESSION'));
  it('reagendamento solicitado ainda conta', () =>
    expect(run([att('a', '1')], [{ ...ses('s', 'a', '1', future, 'Solicitação de reagendamento'), rescheduledStartAt: new Date(future) }])).toBe('SCHEDULED'));
});
