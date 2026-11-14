import { MoodleClient, MoodleError } from './moodle-client';
import {
  mapAssignment,
  mapContents,
  mapCourse,
  mapDiscussion,
  mapEvent,
  mapGrade,
  type MoodleAssignment,
  type MoodleCourse,
  type MoodleDiscussion,
  type MoodleEvent,
  type MoodleForum,
  type MoodleGradeItem,
  type MoodleSection,
} from './moodle-mapper';
import {
  SourceError,
  type FetchedEvent,
  type FetchedGrade,
  type FetchedItem,
  type Provider,
  type SourceContext,
  type SourceFetchResult,
  type SourceGateway,
  type SyncScope,
} from '../../../application/ports/source-gateway';
import { accessOf, type MoodleAccess } from './moodle-access';

export class MoodleGateway implements SourceGateway {
  readonly provider: Provider = 'MOODLE';
  readonly auth = 'token-guardado' as const;

  constructor(private readonly client: MoodleClient = new MoodleClient()) {}

  async fetch(sourceCtx: SourceContext, scope: SyncScope): Promise<SourceFetchResult> {
    try {
      return await this.run(accessOf(sourceCtx), scope);
    } catch (e) {
      if (e instanceof MoodleError) {
        const reauth = e.errorCode === 'invalidtoken' || e.errorCode === 'accessexception';
        throw new SourceError(reauth ? 'REAUTH_NEEDED' : 'UNAVAILABLE', e.message);
      }
      throw e;
    }
  }

  private async run(ctx: MoodleAccess, scope: SyncScope): Promise<SourceFetchResult> {
    const site = await this.client.call<{ userid: number }>(
      ctx,
      'core_webservice_get_site_info',
    );
    const all = await this.client.call<MoodleCourse[]>(
      ctx,
      'core_enrol_get_users_courses',
      { userid: site.userid },
    );
    const courses =
      scope.kind === 'tudo'
        ? all
        : all.filter((c) => String(c.id) === scope.courseExternalId);

    const items: FetchedItem[] = [];
    const grades: FetchedGrade[] = [];
    const partial = { items: [] as string[], grades: [] as string[] };
    const warnings: string[] = [];
    // Uma falha do AVA num curso (ex.: 504 no relatório de notas) não derruba os outros; token inválido derruba.
    const tolerate = async <T>(what: 'items' | 'grades', c: MoodleCourse, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof MoodleError && (e.errorCode === 'invalidtoken' || e.errorCode === 'accessexception')) throw e;
        partial[what].push(String(c.id));
        const label = what === 'items' ? 'conteúdos' : 'notas';
        warnings.push(`${label} de "${c.fullname ?? c.id}" não vieram: ${e instanceof Error ? e.message : 'erro'}`);
        return [];
      }
    };
    for (const c of courses) {
      items.push(...(await tolerate('items', c, () => this.courseItems(ctx, c.id))));
      if (scope.kind !== 'item') {
        grades.push(...(await tolerate('grades', c, () => this.courseGrades(ctx, c.id, site.userid))));
      }
    }

    return {
      ...(partial.items.length || partial.grades.length ? { partial, warnings } : {}),
      courseSpaces: courses.map(mapCourse),
      items:
        scope.kind === 'item'
          ? items.filter((i) => i.externalId === scope.itemExternalId)
          : items,
      grades,
      events: scope.kind === 'tudo' ? await this.upcoming(ctx) : [],
    };
  }

  private async courseItems(ctx: MoodleAccess, courseId: number) {
    const items: FetchedItem[] = [];

    const sections = await this.client.call<MoodleSection[]>(
      ctx,
      'core_course_get_contents',
      { courseid: courseId },
    );
    items.push(...mapContents(courseId, sections));

    const assigns = await this.client.call<{
      courses: { id: number; assignments: MoodleAssignment[] }[];
    }>(ctx, 'mod_assign_get_assignments', { 'courseids[0]': courseId });
    for (const c of assigns.courses ?? []) {
      items.push(...c.assignments.map((a) => mapAssignment(courseId, a)));
    }

    const forums = await this.client.call<MoodleForum[]>(
      ctx,
      'mod_forum_get_forums_by_courses',
      { 'courseids[0]': courseId },
    );
    for (const f of forums) {
      const res = await this.client.call<{ discussions: MoodleDiscussion[] }>(
        ctx,
        'mod_forum_get_forum_discussions',
        { forumid: f.id },
      );
      items.push(...(res.discussions ?? []).map((d) => mapDiscussion(courseId, f, d)));
    }
    return items;
  }

  private async courseGrades(ctx: MoodleAccess, courseId: number, userId: number) {
    const res = await this.client.call<{
      usergrades: { gradeitems: MoodleGradeItem[] }[];
    }>(ctx, 'gradereport_user_get_grade_items', { courseid: courseId, userid: userId });
    return (res.usergrades?.[0]?.gradeitems ?? [])
      .map((g) => mapGrade(courseId, g))
      .filter((g): g is FetchedGrade => !!g);
  }

  private async upcoming(ctx: MoodleAccess): Promise<FetchedEvent[]> {
    const res = await this.client.call<{ events: MoodleEvent[] }>(
      ctx,
      'core_calendar_get_calendar_upcoming_view',
    );
    return (res.events ?? []).map(mapEvent);
  }
}
