import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from '../../domain/siasb/types';
import { computePreviousSlot, computeSituation } from './situation';

const NOW = new Date('2026-11-16T12:00:00Z'); // segunda
const d = (iso: string) => new Date(iso);
const NO_HOLIDAYS = { known: false, dates: [] as string[] };

function sess(id: string, disc: string, attendance: string, startIso: string, label = 'Confirmado'): ClinicalSession {
  const startAt = d(startIso);
  return {
    id,
    attendanceId: attendance,
    disciplineId: disc,
    disciplineName: `Disc ${disc}`,
    firstName: '',
    professorName: 'Prof',
    locationName: 'Sala',
    startAt,
    endAt: new Date(startAt.getTime() + 3_600_000),
    rescheduledStartAt: null,
    statusLabel: label,
  };
}

const att = (id: string, disciplineId: string): ClinicalAttendance => ({
  id,
  disciplineId,
  firstName: '',
  treatmentType: 'PLANNING',
  concluded: false,
});

const disc = (id: string): ClinicalDiscipline => ({ id, name: `Disc ${id}` });

describe('computeSituation (mesmos dados dos testes de SiasbReader.situation)', () => {
  it('dá NO_PATIENT, NO_SESSION e SCHEDULED, com deadline só quando há horário conhecido', () => {
    const r = computeSituation({
      disciplines: [disc('1'), disc('2'), disc('3')],
      activeAttendances: [att('a2', '2'), att('a3', '3')],
      sessions: [
        sess('s1', '3', 'a3', '2026-11-06T13:00:00Z', 'Atendido'),
        sess('s2', '3', 'a3', '2026-11-13T13:00:00Z', 'Atendido'),
        sess('s3', '3', 'a3', '2026-11-27T13:00:00Z', 'Confirmado'),
        sess('s4', '2', 'a2', '2026-11-10T13:00:00Z', 'Cancelado'),
        sess('s5', '2', 'a2', '2026-11-17T13:00:00Z', 'Cancelado'),
      ],
      now: NOW,
      holidays: NO_HOLIDAYS,
    });
    const by = Object.fromEntries(r.map((x) => [x.disciplineId, x]));
    expect(by['1']).toMatchObject({ state: 'NO_PATIENT', nextSlot: null, deadline: null, estimated: true });
    expect(by['2']).toMatchObject({ state: 'NO_SESSION', nextSlot: null, deadline: null, estimated: true });
    expect(by['3'].state).toBe('SCHEDULED');
    expect(by['3'].nextSlot).toEqual(d('2026-11-20T13:00:00Z'));
    expect(by['3'].deadline).toBeInstanceOf(Date);
    expect(by['3'].estimated).toBe(true);
    expect(by['3'].holidaysConsidered).toBe(false);
  });

  it('Confirmado passada e Atendido futura não dão SCHEDULED', () => {
    const [r] = computeSituation({
      disciplines: [disc('2')],
      activeAttendances: [att('a2', '2')],
      sessions: [
        sess('s1', '2', 'a2', '2026-11-10T13:00:00Z', 'Confirmado'),
        sess('s2', '2', 'a2', '2026-11-20T13:00:00Z', 'Atendido'),
      ],
      now: NOW,
      holidays: NO_HOLIDAYS,
    });
    expect(r.state).toBe('NO_SESSION');
  });

  it('usa o horário da semana seguinte quando o prazo do próximo já passou', () => {
    const [r] = computeSituation({
      disciplines: [disc('2')],
      activeAttendances: [att('a2', '2')],
      sessions: [
        sess('s1', '2', 'a2', '2026-11-04T13:00:00Z', 'Atendido'),
        sess('s2', '2', 'a2', '2026-11-11T13:00:00Z', 'Atendido'),
      ],
      now: NOW,
      holidays: NO_HOLIDAYS,
    });
    expect(r.nextSlot).toEqual(d('2026-11-25T13:00:00Z'));
    expect(r.deadline).toEqual(d('2026-11-20T13:00:00Z'));
  });

  it('holidaysConsidered segue o calendário e a margem some quando ele é conhecido', () => {
    const [r] = computeSituation({
      disciplines: [disc('2')],
      activeAttendances: [att('a2', '2')],
      sessions: [
        sess('s1', '2', 'a2', '2026-11-04T13:00:00Z', 'Atendido'),
        sess('s2', '2', 'a2', '2026-11-11T13:00:00Z', 'Atendido'),
      ],
      now: NOW,
      holidays: { known: true, dates: [] },
    });
    expect(r.holidaysConsidered).toBe(true);
    expect(r.nextSlot).toEqual(d('2026-11-18T13:00:00Z'));
    expect(r.deadline).toEqual(d('2026-11-16T13:00:00Z'));
  });
});

describe('computePreviousSlot', () => {
  // sextas 14h da Bahia (17:00Z); 06/11 e 13/11 atendidas formam o horário.
  const BASE = [sess('p1', '1', 'a1', '2026-11-06T17:00:00Z', 'Atendido'), sess('p2', '1', 'a1', '2026-11-13T17:00:00Z', 'Atendido')];
  const prev = (now: string, extra: ClinicalSession[] = [], holidays = NO_HOLIDAYS) =>
    computePreviousSlot({ disciplineId: '1', sessions: [...BASE, ...extra], now: d(now), holidays });

  it('devolve o horário mais recente com prazo <= agora (prazo futuro nunca é devolvido)', () => {
    const r = prev('2026-11-16T12:00:00Z'); // segunda: o prazo da sexta 20/11 (terça 17/11) ainda não passou
    expect(r!.slot).toEqual(d('2026-11-13T17:00:00Z'));
    expect(r!.deadline.getTime()).toBeLessThanOrEqual(d('2026-11-16T12:00:00Z').getTime());
  });

  it('o prazo do horário de 20/11 passou: ele é o mais recente (sem sessão no dia: covered false)', () => {
    const r = prev('2026-11-17T18:00:00Z');
    expect(r!.slot).toEqual(d('2026-11-20T17:00:00Z'));
    expect(r!.deadline).toEqual(d('2026-11-17T17:00:00Z'));
    expect(r!.covered).toBe(false);
  });

  it('com calendário conhecido (sem margem) o prazo é um dia útil mais tarde e o horário anterior muda (não é "7 dias antes")', () => {
    const r = prev('2026-11-17T18:00:00Z', [], { known: true, dates: [] });
    expect(r!.slot).toEqual(d('2026-11-13T17:00:00Z'));
  });

  it('nenhum horário conhecido: null', () => {
    expect(computePreviousSlot({ disciplineId: '1', sessions: [], now: d('2026-11-17T18:00:00Z'), holidays: NO_HOLIDAYS })).toBeNull();
  });

  it('covered: sessão não cancelada no dia (atendida, falta do paciente) sim; cancelada ou não agendada não', () => {
    const day = '2026-11-20T18:00:00Z';
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', day, 'Atendido')])!.covered).toBe(true);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', day, 'Falta paciente')])!.covered).toBe(true);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', day, 'Confirmado')])!.covered).toBe(true);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', day, 'Cancelada')])!.covered).toBe(false);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', day, 'Não agendado')])!.covered).toBe(false);
  });

  it('covered usa o dia da Bahia: 23:30 do dia 20 conta, 00:30 do dia 21 não; outra disciplina não cobre', () => {
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', '2026-11-21T02:30:00Z', 'Atendido')])!.covered).toBe(true);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '1', 'a1', '2026-11-21T03:30:00Z', 'Atendido')])!.covered).toBe(false);
    expect(prev('2026-11-17T18:00:00Z', [sess('x', '2', 'a9', '2026-11-20T18:00:00Z', 'Atendido')])!.covered).toBe(false);
  });
});
