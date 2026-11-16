import { assessAttendance } from '../../domain/academic/attendance';
import type { FrequenciaViva } from '../../application/ports/live-source';
import type { AttendanceResponse } from '../../application/web/contract';

/** Frequência ao vivo do SIGAA → JSON da API (inglês), com a regra de faltas de 25% aplicada no domínio. */
export function toAttendance(list: FrequenciaViva[]): AttendanceResponse {
  const courses = list.map((f) => {
    const a = assessAttendance({
      presentClasses: f.presencas,
      recordedClasses: f.aulasRegistradas,
      workloadClasses: f.aulasCH,
    });
    return {
      courseId: f.cursoId,
      courseName: f.cursoNome,
      presentClasses: f.presencas,
      recordedClasses: f.aulasRegistradas,
      workloadClasses: f.aulasCH,
      absentClasses: a.absentClasses,
      allowedAbsentClasses: a.allowedAbsentClasses,
      remainingAbsentClasses: a.remainingAbsentClasses,
      status: a.status,
      complete: f.completa,
    };
  });
  return {
    courses,
    summary: {
      absentClasses: courses.reduce((n, c) => n + c.absentClasses, 0),
      allowedAbsentClasses: courses.reduce((n, c) => n + c.allowedAbsentClasses, 0),
      atRiskCourses: courses.filter((c) => c.status !== 'ok').length,
    },
  };
}
