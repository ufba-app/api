import { MoodleClient } from './moodle-client';
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
import type {
  FetchedEvent,
  FetchedGrade,
  FetchedItem,
  SourceContext,
  SourceFetchResult,
  SourceGateway,
  SyncScope,
} from './source-types';

export class MoodleGateway implements SourceGateway {
  readonly source = 'MOODLE' as const;
  readonly auth = 'token-guardado' as const;

  constructor(private readonly client: MoodleClient = new MoodleClient()) {}

  async fetch(ctx: SourceContext, scope: SyncScope): Promise<SourceFetchResult> {
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
      scope.kind === 'all'
        ? all
        : all.filter((c) => String(c.id) === scope.courseExternalId);

    const items: FetchedItem[] = [];
    const grades: FetchedGrade[] = [];
    for (const c of courses) {
      items.push(...(await this.courseItems(ctx, c.id)));
      if (scope.kind !== 'item') {
        grades.push(...(await this.courseGrades(ctx, c.id, site.userid)));
      }
    }

    return {
      courseSpaces: courses.map(mapCourse),
      items:
        scope.kind === 'item'
          ? items.filter((i) => i.externalId === scope.itemExternalId)
          : items,
      grades,
      events: scope.kind === 'all' ? await this.upcoming(ctx) : [],
    };
  }

  private async courseItems(ctx: SourceContext, courseId: number) {
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

  private async courseGrades(ctx: SourceContext, courseId: number, userId: number) {
    const res = await this.client.call<{
      usergrades: { gradeitems: MoodleGradeItem[] }[];
    }>(ctx, 'gradereport_user_get_grade_items', { courseid: courseId, userid: userId });
    return (res.usergrades?.[0]?.gradeitems ?? [])
      .map((g) => mapGrade(courseId, g))
      .filter((g): g is FetchedGrade => !!g);
  }

  private async upcoming(ctx: SourceContext): Promise<FetchedEvent[]> {
    const res = await this.client.call<{ events: MoodleEvent[] }>(
      ctx,
      'core_calendar_get_calendar_upcoming_view',
    );
    return (res.events ?? []).map(mapEvent);
  }
}
