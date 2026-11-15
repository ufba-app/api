import type { ClinicalSession } from '../../domain/siasb/types';
import { computeProgress, PROGRESS_NOT_STARTED_WARNING } from './progress';

const d = (iso: string) => new Date(iso);

function sess(id: string, startIso: string, label: string): ClinicalSession {
  const startAt = d(startIso);
  return {
    id,
    attendanceId: 'a1',
    disciplineId: '3',
    disciplineName: 'Disc 3',
    initials: 'AB',
    professorName: 'Prof',
    locationName: 'Sala',
    startAt,
    endAt: new Date(startAt.getTime() + 3_600_000),
    rescheduledStartAt: null,
    statusLabel: label,
  };
}

function rhythm(input: { from: string; to: string; now: string; sessions: ClinicalSession[] }) {
  return computeProgress({
    disciplines: [{ id: '3', name: 'Disc 3' }],
    active: [],
    inactive: [],
    sessions: input.sessions,
    range: { from: d(input.from), to: d(input.to) },
    isDefault: false,
    now: d(input.now),
  });
}

// Meia-noite da Bahia = 03:00Z. 02/11/2026 é segunda.
const FROM = '2026-11-02T03:00:00Z';

describe('computeProgress: ritmo só sobre o período decorrido', () => {
  it('ate no futuro: semanas futuras sem sessão não contam e a taxa não é diluída', () => {
    // Agora = 23/11 00:00 (Bahia): 21 dias decorridos = 3 blocos de 7 dias (02-09, 09-16, 16-23).
    const r = rhythm({
      from: FROM,
      to: '2026-12-28T02:59:59Z',
      now: '2026-11-23T03:00:00Z',
      sessions: [
        sess('s1', '2026-11-03T13:00:00Z', 'Atendido'), // bloco 1
        sess('s2', '2026-11-10T13:00:00Z', 'Atendido'), // bloco 2
        sess('s3', '2026-11-30T13:00:00Z', 'Confirmado'), // semana futura: fora do ritmo
      ],
    });
    expect(r.rhythm.weeksWithoutSession).toBe(1); // só o bloco 16-23; as semanas de 23/11 em diante ficam de fora
    expect(r.rhythm.sessionsPerWeek).toBe(0.67); // 2 sessões / 3 semanas decorridas
  });

  it('semana só com sessão cancelada conta como semana sem sessão', () => {
    const r = rhythm({
      from: FROM,
      to: '2026-12-28T02:59:59Z',
      now: '2026-11-23T03:00:00Z',
      sessions: [
        sess('s1', '2026-11-03T13:00:00Z', 'Atendido'), // bloco 1
        sess('s2', '2026-11-10T13:00:00Z', 'Cancelado'), // bloco 2: só cancelada
        sess('s3', '2026-11-17T13:00:00Z', 'Cancelada'), // bloco 3: só cancelada
      ],
    });
    expect(r.rhythm.weeksWithoutSession).toBe(2);
  });

  it('período de 3 dias com 3 sessões: 3 sessões em 3/7 de semana = 7 por semana', () => {
    const r = rhythm({
      from: FROM,
      to: '2026-11-05T03:00:00Z',
      now: '2026-11-23T12:00:00Z',
      sessions: [
        sess('s1', '2026-11-02T13:00:00Z', 'Atendido'),
        sess('s2', '2026-11-03T13:00:00Z', 'Atendido'),
        sess('s3', '2026-11-04T13:00:00Z', 'Atendido'),
      ],
    });
    expect(r.rhythm.sessionsPerWeek).toBe(7);
    expect(r.rhythm.weeksWithoutSession).toBe(0); // nenhum bloco completo de 7 dias
  });

  it('menos de 1 dia decorrido: sessionsPerWeek é null', () => {
    const r = rhythm({
      from: '2026-11-23T03:00:00Z',
      to: '2026-12-01T02:59:59Z',
      now: '2026-11-23T12:00:00Z', // 9 horas
      sessions: [sess('s1', '2026-11-23T10:00:00Z', 'Atendido')],
    });
    expect(r.rhythm.sessionsPerWeek).toBeNull();
    expect(r.rhythm.weeksWithoutSession).toBe(0);
  });

  it('zero sessões em 3 semanas decorridas: 3 semanas sem sessão e taxa 0', () => {
    const r = rhythm({ from: FROM, to: '2026-12-20T02:59:59Z', now: '2026-11-23T03:00:00Z', sessions: [] });
    expect(r.rhythm.weeksWithoutSession).toBe(3);
    expect(r.rhythm.sessionsPerWeek).toBe(0);
  });

  it('período que ainda não começou: ritmo zerado e aviso em pt-BR', () => {
    const r = rhythm({
      from: '2026-11-30T03:00:00Z',
      to: '2026-12-20T02:59:59Z',
      now: '2026-11-23T12:00:00Z',
      sessions: [sess('s1', '2026-12-01T13:00:00Z', 'Confirmado')],
    });
    expect(r.rhythm.sessionsPerWeek).toBeNull();
    expect(r.rhythm.weeksWithoutSession).toBe(0);
    expect(r.warnings).toContain(PROGRESS_NOT_STARTED_WARNING);
    expect(PROGRESS_NOT_STARTED_WARNING).toMatch(/ainda não começou/);
  });
});
