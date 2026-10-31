import { contentHash } from '../../domain/kernel/content-hash';
import type {
  FetchedCourseSpace,
  FetchedEvent,
  FetchedGrade,
  FetchedItem,
} from '../ports/source-gateway';

const iso = (d?: Date): string | null => (d ? d.toISOString() : null);

export const courseSpaceHash = (
  c: Pick<FetchedCourseSpace, 'name' | 'extra'>,
): string => contentHash({ name: c.name, extra: c.extra ?? null });

export const itemHash = (i: FetchedItem): string =>
  contentHash({
    title: i.title,
    body: i.body ?? null,
    dueAt: iso(i.dueAt),
    publishedAt: iso(i.publishedAt),
    state: i.state ?? null,
    extra: i.extra ?? null,
    attachments: (i.attachments ?? []).map((a) => [
      a.externalId ?? null,
      a.name,
      a.sizeBytes ?? null,
    ]),
  });

export const gradeHash = (g: FetchedGrade): string =>
  contentHash({
    label: g.label,
    score: g.score ?? null,
    maxScore: g.maxScore ?? null,
    weight: g.weight ?? null,
    gradedAt: iso(g.gradedAt),
    item: g.itemExternalId ?? null,
  });

export const eventHash = (e: FetchedEvent): string =>
  contentHash({
    title: e.title,
    description: e.description ?? null,
    location: e.location ?? null,
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    allDay: e.allDay ?? false,
    status: e.status ?? null,
  });
