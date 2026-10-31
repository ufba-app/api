import type {
  NormalizedAttachment,
  NormalizedCourseSpace,
  NormalizedGrade,
  NormalizedItem,
} from '../google/types';

/** Subconjunto das respostas da Classroom API v1 que usamos. */
export interface GcMaterial {
  driveFile?: { driveFile?: { id?: string; title?: string; alternateLink?: string } };
  youTubeVideo?: { id?: string; title?: string; alternateLink?: string };
  link?: { url?: string; title?: string };
  form?: { formUrl?: string; title?: string };
}
export interface GcCourse {
  id: string;
  name: string;
  section?: string;
  descriptionHeading?: string;
  courseState?: string;
  alternateLink?: string;
  enrollmentCode?: string;
}
interface GcDate {
  year?: number;
  month?: number;
  day?: number;
}
interface GcTime {
  hours?: number;
  minutes?: number;
  seconds?: number;
}
export interface GcAnnouncement {
  id: string;
  text?: string;
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  materials?: GcMaterial[];
}
export interface GcCourseWork {
  id: string;
  title?: string;
  description?: string;
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  dueDate?: GcDate;
  dueTime?: GcTime;
  maxPoints?: number;
  workType?: string;
  materials?: GcMaterial[];
}
export interface GcMaterialPost {
  id: string;
  title?: string;
  description?: string;
  state?: string;
  alternateLink?: string;
  creationTime?: string;
  updateTime?: string;
  materials?: GcMaterial[];
}
export interface GcSubmission {
  id: string;
  courseId?: string;
  courseWorkId?: string;
  state?: string;
  assignedGrade?: number;
  draftGrade?: number;
  updateTime?: string;
}

const date = (s?: string): Date | null => (s ? new Date(s) : null);

function dueAt(d?: GcDate, t?: GcTime): Date | null {
  if (!d?.year || !d.month || !d.day) return null;
  // dueTime é UTC; sem horário, vale o fim do dia.
  return new Date(Date.UTC(d.year, d.month - 1, d.day, t?.hours ?? 23, t?.minutes ?? 59, t?.seconds ?? 0));
}

export function mapMaterials(materials: GcMaterial[] = []): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const m of materials) {
    if (m.driveFile?.driveFile) {
      const f = m.driveFile.driveFile;
      out.push({
        externalId: f.id ?? null,
        name: f.title ?? 'arquivo',
        mimeType: null, // a Classroom não informa o mime; é descoberto no Drive ao baixar
        sourceUrl: f.alternateLink ?? null,
        extra: { type: 'drive', driveId: f.id },
      });
    } else if (m.youTubeVideo) {
      const v = m.youTubeVideo;
      out.push({
        externalId: v.id ?? null,
        name: v.title ?? 'vídeo',
        mimeType: 'video/youtube',
        sourceUrl: v.alternateLink ?? null,
        extra: { type: 'youtube' },
      });
    } else if (m.link) {
      out.push({
        externalId: m.link.url ?? null,
        name: m.link.title ?? m.link.url ?? 'link',
        mimeType: 'text/uri-list',
        sourceUrl: m.link.url ?? null,
        extra: { type: 'link' },
      });
    } else if (m.form) {
      out.push({
        externalId: m.form.formUrl ?? null,
        name: m.form.title ?? 'formulário',
        mimeType: 'application/vnd.google-apps.form',
        sourceUrl: m.form.formUrl ?? null,
        extra: { type: 'form' },
      });
    }
  }
  return out;
}

export function mapCourse(c: GcCourse): NormalizedCourseSpace {
  return {
    externalId: c.id,
    name: c.name,
    extra: {
      section: c.section ?? null,
      descriptionHeading: c.descriptionHeading ?? null,
      courseState: c.courseState ?? null,
      url: c.alternateLink ?? null,
    },
  };
}

export function mapAnnouncement(courseId: string, a: GcAnnouncement): NormalizedItem {
  const text = a.text ?? '';
  return {
    externalId: a.id,
    courseExternalId: courseId,
    kind: 'ANNOUNCEMENT',
    title: text.split('\n')[0].slice(0, 120) || 'Aviso',
    body: text || null,
    url: a.alternateLink ?? null,
    publishedAt: date(a.creationTime),
    dueAt: null,
    attachments: mapMaterials(a.materials),
    extra: { state: a.state ?? null, updatedAt: a.updateTime ?? null },
  };
}

export function mapCourseWork(courseId: string, w: GcCourseWork): NormalizedItem {
  return {
    externalId: w.id,
    courseExternalId: courseId,
    kind: 'ASSIGNMENT',
    title: w.title ?? 'Tarefa',
    body: w.description ?? null,
    url: w.alternateLink ?? null,
    publishedAt: date(w.creationTime),
    dueAt: dueAt(w.dueDate, w.dueTime),
    attachments: mapMaterials(w.materials),
    extra: {
      state: w.state ?? null,
      workType: w.workType ?? null,
      maxPoints: w.maxPoints ?? null,
      updatedAt: w.updateTime ?? null,
    },
  };
}

export function mapMaterialPost(courseId: string, m: GcMaterialPost): NormalizedItem {
  return {
    externalId: m.id,
    courseExternalId: courseId,
    kind: 'MATERIAL',
    title: m.title ?? 'Material',
    body: m.description ?? null,
    url: m.alternateLink ?? null,
    publishedAt: date(m.creationTime),
    dueAt: null,
    attachments: mapMaterials(m.materials),
    extra: { state: m.state ?? null, updatedAt: m.updateTime ?? null },
  };
}

/** Nota de uma submissão; null se ainda não há nota atribuída. */
export function mapSubmission(
  courseId: string,
  s: GcSubmission,
  work?: { title?: string; maxPoints?: number },
): NormalizedGrade | null {
  if (s.assignedGrade === undefined) return null;
  return {
    externalId: s.id,
    courseExternalId: courseId,
    itemExternalId: s.courseWorkId ?? null,
    label: work?.title ?? 'Tarefa',
    score: s.assignedGrade,
    maxScore: work?.maxPoints ?? null,
    gradedAt: date(s.updateTime),
  };
}
