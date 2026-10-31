import { contentHash } from '../../../domain/kernel/content-hash';
import type {
  FetchedAttachment,
  FetchedCourseSpace,
  FetchedEvent,
  FetchedGrade,
  FetchedItem,
} from './source-types';

// --- formas (parciais) das respostas do Moodle ---
export interface MoodleFile {
  filename: string;
  filepath?: string;
  filesize?: number;
  fileurl: string;
  mimetype?: string;
  timemodified?: number;
  type?: string;
}
export interface MoodleCourse {
  id: number;
  fullname: string;
  shortname?: string;
  idnumber?: string;
}
export interface MoodleModule {
  id: number;
  name: string;
  modname: string;
  description?: string;
  url?: string;
  contents?: MoodleFile[];
  visible?: number;
}
export interface MoodleSection {
  id: number;
  name: string;
  modules?: MoodleModule[];
}
export interface MoodleAssignment {
  id: number;
  cmid?: number;
  name: string;
  intro?: string;
  duedate?: number;
  allowsubmissionsfromdate?: number;
  timemodified?: number;
  introattachments?: MoodleFile[];
}
export interface MoodleForum {
  id: number;
  cmid?: number;
  name: string;
  type: string;
}
export interface MoodleDiscussion {
  id: number;
  discussion?: number;
  name: string;
  message?: string;
  created?: number;
  timemodified?: number;
  attachments?: MoodleFile[];
}
export interface MoodleGradeItem {
  id: number;
  itemname?: string | null;
  graderaw?: number | null;
  grademax?: number | null;
  weightraw?: number | null;
  gradedategraded?: number | null;
}
export interface MoodleEvent {
  id: number;
  name: string;
  description?: string;
  timestart: number;
  timeduration?: number;
  eventtype?: string;
  course?: { id: number };
}

const date = (s?: number | null) => (s ? new Date(s * 1000) : undefined);

/** Tira o token de URLs que o Moodle às vezes já devolve com `?token=`. */
export function cleanUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('token');
  return u.toString();
}

export function mapFile(f: MoodleFile): FetchedAttachment {
  return {
    externalId: `${f.filepath ?? '/'}${f.filename}`,
    name: f.filename,
    mimeType: f.mimetype,
    sizeBytes: f.filesize,
    sourceUrl: cleanUrl(f.fileurl),
  };
}

function item(
  courseId: number,
  partial: Omit<FetchedItem, 'courseExternalId' | 'contentHash'>,
): FetchedItem {
  const base = { courseExternalId: String(courseId), ...partial };
  return { ...base, contentHash: contentHash(base) };
}

export function mapCourse(c: MoodleCourse): FetchedCourseSpace {
  return {
    externalId: String(c.id),
    name: c.fullname,
    extra: { shortname: c.shortname, idnumber: c.idnumber },
  };
}

/** Seções/módulos → MATERIAL. Tarefas e fóruns vêm de funções próprias, então são ignorados aqui. */
export function mapContents(courseId: number, sections: MoodleSection[]): FetchedItem[] {
  const out: FetchedItem[] = [];
  for (const s of sections) {
    for (const m of s.modules ?? []) {
      if (m.visible === 0) continue;
      if (['assign', 'forum', 'label'].includes(m.modname)) continue;
      const contents = m.contents ?? [];
      out.push(
        item(courseId, {
          kind: m.modname === 'quiz' ? 'ASSESSMENT' : 'MATERIAL',
          externalId: `cm${m.id}`,
          title: m.name,
          body: m.description,
          attachments: contents.filter((f) => f.type !== 'url').map(mapFile),
          extra: {
            section: s.name,
            modname: m.modname,
            url: m.url,
            externalLinks: contents.filter((f) => f.type === 'url').map((f) => f.fileurl),
          },
        }),
      );
    }
  }
  return out;
}

export function mapAssignment(courseId: number, a: MoodleAssignment): FetchedItem {
  return item(courseId, {
    kind: 'ASSIGNMENT',
    externalId: `assign${a.id}`,
    title: a.name,
    body: a.intro,
    dueAt: date(a.duedate),
    publishedAt: date(a.allowsubmissionsfromdate),
    attachments: (a.introattachments ?? []).map(mapFile),
    extra: { cmid: a.cmid, modifiedAt: a.timemodified },
  });
}

/** Fórum do tipo `news` é o quadro de avisos: suas discussões viram ANNOUNCEMENT. */
export function mapDiscussion(
  courseId: number,
  forum: MoodleForum,
  d: MoodleDiscussion,
): FetchedItem {
  return item(courseId, {
    kind: forum.type === 'news' ? 'ANNOUNCEMENT' : 'FORUM_TOPIC',
    externalId: `disc${d.discussion ?? d.id}`,
    title: d.name,
    body: d.message,
    publishedAt: date(d.created),
    attachments: (d.attachments ?? []).map(mapFile),
    extra: { forumId: forum.id, forumName: forum.name, modifiedAt: d.timemodified },
  });
}

export function mapGrade(courseId: number, g: MoodleGradeItem): FetchedGrade | undefined {
  if (!g.itemname) return undefined; // item-síntese (categoria/total) sem nome
  const base = {
    courseExternalId: String(courseId),
    externalId: `gi${g.id}`,
    label: g.itemname,
    score: g.graderaw ?? undefined,
    maxScore: g.grademax ?? undefined,
    weight: g.weightraw ?? undefined,
    gradedAt: date(g.gradedategraded),
  };
  return { ...base, contentHash: contentHash(base) };
}

export function mapEvent(e: MoodleEvent): FetchedEvent {
  const base = {
    courseExternalId: e.course ? String(e.course.id) : undefined,
    externalId: `ev${e.id}`,
    title: e.name,
    description: e.description,
    startsAt: new Date(e.timestart * 1000),
    endsAt: e.timeduration ? new Date((e.timestart + e.timeduration) * 1000) : undefined,
    kind: e.eventtype,
  };
  return { ...base, contentHash: contentHash(base) };
}
