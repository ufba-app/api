import { GoogleHttp } from '../google/google-http';
import { emptyResult, type FetchResult, type SourceContext, type SyncScope } from '../google/types';
import {
  mapAnnouncement,
  mapCourse,
  mapCourseWork,
  mapMaterialPost,
  mapSubmission,
  type GcAnnouncement,
  type GcCourse,
  type GcCourseWork,
  type GcMaterialPost,
  type GcSubmission,
} from './classroom-mapper';

const BASE = 'https://classroom.googleapis.com/v1';

/** Escopos OAuth necessários (somente leitura). */
export const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/** Fonte Google Classroom. Autenticação: refresh token guardado (cifrado). */
export class ClassroomGateway {
  readonly source = 'CLASSROOM';
  readonly auth = 'token-guardado' as const;

  constructor(private readonly http: GoogleHttp) {}

  async fetch(ctx: SourceContext, scope: SyncScope = { type: 'all' }): Promise<FetchResult> {
    const rt = ctx.refreshToken;
    const result = emptyResult();

    const courses =
      scope.type === 'all'
        ? await this.http.list<GcCourse>(rt, `${BASE}/courses`, 'courses', {
            courseStates: 'ACTIVE',
            studentId: 'me',
          })
        : [await this.http.getJson<GcCourse>(rt, `${BASE}/courses/${enc(scope.courseId)}`)];

    for (const course of courses) {
      result.courseSpaces.push(mapCourse(course));
      await this.fetchCourse(rt, course.id, result);
    }

    if (scope.type === 'item') {
      result.items = result.items.filter((i) => i.externalId === scope.itemId);
    }
    return result;
  }

  private async fetchCourse(rt: string, courseId: string, out: FetchResult): Promise<void> {
    const c = `${BASE}/courses/${enc(courseId)}`;
    const [announcements, work, materials, submissions] = await Promise.all([
      this.http.list<GcAnnouncement>(rt, `${c}/announcements`, 'announcements'),
      this.http.list<GcCourseWork>(rt, `${c}/courseWork`, 'courseWork'),
      this.http.list<GcMaterialPost>(rt, `${c}/courseWorkMaterials`, 'courseWorkMaterial'),
      this.http.list<GcSubmission>(rt, `${c}/courseWork/-/studentSubmissions`, 'studentSubmissions', {
        userId: 'me',
      }),
    ]);

    out.items.push(
      ...announcements.map((a) => mapAnnouncement(courseId, a)),
      ...work.map((w) => mapCourseWork(courseId, w)),
      ...materials.map((m) => mapMaterialPost(courseId, m)),
    );

    const workById = new Map(work.map((w) => [w.id, w]));
    for (const s of submissions) {
      const grade = mapSubmission(courseId, s, workById.get(s.courseWorkId ?? ''));
      if (grade) out.grades.push(grade);
    }
  }
}

const enc = encodeURIComponent;
