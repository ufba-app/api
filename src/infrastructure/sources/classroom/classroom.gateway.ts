import type { Secret } from '../../../application/shared/secret';
import { GoogleHttp } from '../google/google-http';
import type {
  FetchedCourseSpace,
  FetchedGrade,
  FetchedItem,
  SourceContext,
  SourceFetchResult,
  SourceGateway,
  SyncScope,
} from '../../../application/ports/source-gateway';
import { refreshTokenOf, translateErrors } from '../google/google-errors';
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
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/** Fonte Google Classroom. Autenticação: refresh token guardado (cifrado). */
export class ClassroomGateway implements SourceGateway {
  readonly provider = 'CLASSROOM' as const;
  readonly auth = 'token-guardado' as const;

  constructor(private readonly http: GoogleHttp) {}

  async fetch(ctx: SourceContext, scope: SyncScope = { kind: 'tudo' }): Promise<SourceFetchResult> {
    return translateErrors(() => this.doFetch(ctx, scope));
  }

  private async doFetch(ctx: SourceContext, scope: SyncScope): Promise<SourceFetchResult> {
    const rt = refreshTokenOf(ctx);
    const result = { courseSpaces: [] as FetchedCourseSpace[], items: [] as FetchedItem[], grades: [] as FetchedGrade[] };

    const courses =
      scope.kind === 'tudo'
        ? await this.http.list<GcCourse>(rt, `${BASE}/courses`, 'courses', {
            courseStates: 'ACTIVE',
            studentId: 'me',
          })
        : [await this.http.getJson<GcCourse>(rt, `${BASE}/courses/${enc(scope.courseExternalId)}`)];

    for (const course of courses) {
      result.courseSpaces.push(mapCourse(course));
      await this.fetchCourse(rt, course.id, result);
    }

    if (scope.kind === 'item') {
      result.items = result.items.filter((i) => i.externalId === scope.itemExternalId);
    }
    return result;
  }

  private async fetchCourse(rt: Secret, courseId: string, out: { items: FetchedItem[]; grades: FetchedGrade[] }): Promise<void> {
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
