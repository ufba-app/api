import { syntheticTranscript } from './__fixtures__/transcript.fixture';
import {
  buildPendingQueue,
  computeCr,
  pendingSummary,
  termTrajectory,
  transcriptInsights,
} from './insights';
import { compareTerms, nextTerm, termDistance } from './term';
import { validateTranscript } from './validate-transcript';

describe('term', () => {
  it('avança e compara semestres', () => {
    expect(nextTerm('2026.1')).toBe('2026.2');
    expect(nextTerm('2026.2')).toBe('2027.1');
    expect(compareTerms('2025.2', '2026.1')).toBeLessThan(0);
    expect(termDistance('2025.2', '2027.1')).toBe(3);
    expect(termDistance('2027.1', '2025.2')).toBe(-3);
  });
});

describe('insights', () => {
  it('CR pondera por carga horária e ignora linhas sem nota', () => {
    expect(computeCr(syntheticTranscript().entries)).toBeCloseTo(6.7778, 4);
    expect(computeCr([])).toBeNull();
  });

  it('trajetória por semestre, com CR do período e acumulado', () => {
    const t = termTrajectory(syntheticTranscript().entries);
    expect(t.map((s) => s.term)).toEqual(['2024.1', '2024.2', '2025.1']);
    expect(t[0].cr).toBe(7);
    expect(t[0].hoursCompleted).toBe(120);
    expect(t[0].counts).toEqual({ APR: 2, TRANC: 1 });
    expect(t[1].cumulativeHoursCompleted).toBe(210);
    expect(t[2].cumulativeCr).toBeCloseTo(6.7778, 4);
  });

  it('pendentes: separa cursando e ENADE', () => {
    const p = pendingSummary(syntheticTranscript().pending);
    expect(p.toTake.map((x) => x.code)).toEqual(['MATA04']);
    expect(p.enrolled.map((x) => x.code)).toEqual(['MATA05']);
    expect(p.enadePending).toBe(true);
    expect(p.hoursToTake).toBe(60);
  });

  it('fila de pendentes: atrasadas primeiro, sem período no fim, equivalência herda período', () => {
    const pending = [
      { code: 'X9', name: 'obsoleta', hours: 30, enrolled: false },
      { code: 'OLD1', name: 'antiga', hours: 60, enrolled: false },
      { code: 'B2', name: 'b', hours: 60, enrolled: false },
      { code: 'A1', name: 'a', hours: 60, enrolled: false },
      { code: 'ENADE', name: 'ENADE', hours: 0, enrolled: false },
      { code: 'C3', name: 'c', hours: 60, enrolled: true },
    ];
    const queue = buildPendingQueue(
      pending,
      [
        { code: 'A1', term: 1, prerequisite: null },
        { code: 'B2', term: 4, prerequisite: 'A1' },
        { code: 'NEW1', term: 2, prerequisite: null },
      ],
      [{ code: 'OLD1', equivalentOf: 'NEW1' }],
      3,
    );
    expect(queue.map((q) => q.code)).toEqual(['A1', 'OLD1', 'B2', 'X9']);
    expect(queue[0].late).toBe(true);
    expect(queue[1]).toMatchObject({ term: 2, substitute: 'NEW1', late: true });
    expect(queue[2].prerequisite).toBe('A1');
    expect(queue[3]).toMatchObject({ term: null, late: false });
  });

  it('agrega os insights', () => {
    const i = transcriptInsights(syntheticTranscript());
    expect(i.hoursCompleted).toBe(210);
    expect(i.trajectory).toHaveLength(3);
  });
});

describe('validateTranscript', () => {
  it('histórico consistente não tem divergências', () => {
    const r = validateTranscript(syntheticTranscript());
    expect(r.divergences).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('acusa CR divergente', () => {
    const t = syntheticTranscript();
    t.cr = 8.5;
    const r = validateTranscript(t);
    expect(r.ok).toBe(false);
    expect(r.divergences).toContainEqual(
      expect.objectContaining({ code: 'CR_MISMATCH', declared: 8.5 }),
    );
  });

  it('acusa CR ausente quando há notas', () => {
    const t = syntheticTranscript();
    t.cr = null;
    expect(validateTranscript(t).divergences.map((d) => d.code)).toContain(
      'CR_MISSING',
    );
  });

  it('carga horária por natureza: total fecha mas divisão não vira warning', () => {
    const t = syntheticTranscript();
    t.entries[3].nature = 'OB'; // optativa lida como obrigatória
    const r = validateTranscript(t);
    expect(r.ok).toBe(true);
    expect(r.divergences.map((d) => [d.code, d.severity])).toEqual([
      ['HOURS_REQUIRED', 'warning'],
      ['HOURS_ELECTIVE', 'warning'],
    ]);
  });

  it('carga horária: linha faltando vira erro', () => {
    const t = syntheticTranscript();
    t.entries.splice(0, 1); // some MATA01 (60h obrigatórias)
    t.cr = computeCr(t.entries);
    const r = validateTranscript(t);
    expect(r.ok).toBe(false);
    const codes = r.divergences.map((d) => d.code);
    expect(codes).toContain('HOURS_ROWS_TOTAL');
    expect(codes).toContain('HOURS_REQUIRED');
  });

  it('total do quadro que não é a soma das colunas', () => {
    const t = syntheticTranscript();
    t.hoursMatrix.total.done = 999;
    expect(validateTranscript(t).divergences.map((d) => d.code)).toEqual([
      'HOURS_TOTAL_COLUMNS',
    ]);
  });

  it('nota ou horas impossíveis', () => {
    const t = syntheticTranscript();
    t.entries[0].grade = 80;
    expect(validateTranscript(t).divergences.map((d) => d.code)).toContain(
      'ENTRY_INVALID',
    );
  });

  it('complementares não entram na soma por linhas', () => {
    const t = syntheticTranscript();
    t.hoursMatrix.complementary.done = 144;
    t.hoursMatrix.total.done = 354;
    expect(validateTranscript(t).ok).toBe(true);
  });
});
