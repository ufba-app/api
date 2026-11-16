import type { FrequenciaViva } from '../../application/ports/live-source';
import { AttendanceResponse } from '../../application/web/contract';
import { toAttendance } from './attendance.mapper';

const base: FrequenciaViva = {
  cursoId: 'anatomia',
  cursoNome: 'Anatomia',
  presencas: 21,
  aulasRegistradas: 29,
  aulasCH: 32,
  completa: true,
};

describe('toAttendance', () => {
  it('traduz os números do SIGAA e aplica a regra de faltas', () => {
    expect(toAttendance([base]).courses).toEqual([
      {
        courseId: 'anatomia',
        courseName: 'Anatomia',
        presentClasses: 21,
        recordedClasses: 29,
        workloadClasses: 32,
        absentClasses: 8,
        allowedAbsentClasses: 8,
        remainingAbsentClasses: 0,
        status: 'at_risk',
        complete: true,
      },
    ]);
  });

  it('o resumo soma faltas e limites e conta em risco as disciplinas at_risk e failed', () => {
    const ok = { ...base, cursoId: 'b', presencas: 29, completa: false };
    const failed = { ...base, cursoId: 'c', presencas: 20 };
    const r = toAttendance([base, ok, failed]);
    expect(r.courses.map((c) => c.status)).toEqual(['at_risk', 'ok', 'failed']);
    expect(r.summary).toEqual({ absentClasses: 8 + 0 + 9, allowedAbsentClasses: 24, atRiskCourses: 2 });
    expect(r.courses[1].complete).toBe(false);
  });

  it('sem turmas: lista vazia e resumo zerado', () => {
    expect(toAttendance([])).toEqual({
      courses: [],
      summary: { absentClasses: 0, allowedAbsentClasses: 0, atRiskCourses: 0 },
    });
  });

  it('o resultado cumpre o contrato da API', () => {
    expect(() => AttendanceResponse.parse(toAttendance([base]))).not.toThrow();
  });
});
