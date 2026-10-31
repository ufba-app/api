import type {
  FetchedAttachment,
  FetchedCourseSpace,
  FetchedGrade,
  FetchedItem,
} from '../../../application/ports/source-gateway';

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


const date = (s?: string): Date | undefined => (s ? new Date(s) : undefined);

function dueAt(d?: GcDate, t?: GcTime): Date | undefined {
  if (!d?.year || !d.month || !d.day) return undefined;
  // dueTime é UTC; sem horário, vale o fim do dia.
  return new Date(Date.UTC(d.year, d.month - 1, d.day, t?.hours ?? 23, t?.minutes ?? 59, t?.seconds ?? 0));
}

export function mapMaterials(materials: GcMaterial[] = []): FetchedAttachment[] {
  const out: FetchedAttachment[] = [];
  for (const m of materials) {
    if (m.driveFile?.driveFile) {
      const f = m.driveFile.driveFile;
      // A Classroom não informa o mime; é descoberto no Drive ao baixar. O driveId é o externalId.
      out.push({ externalId: f.id, name: f.title ?? 'arquivo', sourceUrl: f.alternateLink });
    } else if (m.youTubeVideo) {
      const v = m.youTubeVideo;
      out.push({ externalId: v.id, name: v.title ?? 'vídeo', mimeType: 'video/youtube', sourceUrl: v.alternateLink });
    } else if (m.link) {
      out.push({
        externalId: m.link.url,
        name: m.link.title ?? m.link.url ?? 'link',
        mimeType: 'text/uri-list',
        sourceUrl: m.link.url,
      });
    } else if (m.form) {
      out.push({
        externalId: m.form.formUrl,
        name: m.form.title ?? 'formulário',
        mimeType: 'application/vnd.google-apps.form',
        sourceUrl: m.form.formUrl,
      });
    }
  }
  return out;
}

export function mapCourse(c: GcCourse): FetchedCourseSpace {
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

export function mapAnnouncement(courseId: string, a: GcAnnouncement): FetchedItem {
  const text = a.text ?? '';
  return {
    courseExternalId: courseId,
    kind: 'ANNOUNCEMENT',
    externalId: a.id,
    title: text.split('\n')[0].slice(0, 120) || 'Aviso',
    body: text || undefined,
    publishedAt: date(a.creationTime),
    state: a.state,
    extra: { url: a.alternateLink ?? null, updatedAt: a.updateTime ?? null },
    attachments: mapMaterials(a.materials),
  };
}

export function mapCourseWork(courseId: string, w: GcCourseWork): FetchedItem {
  return {
    courseExternalId: courseId,
    kind: 'ASSIGNMENT',
    externalId: w.id,
    title: w.title ?? 'Tarefa',
    body: w.description,
    publishedAt: date(w.creationTime),
    dueAt: dueAt(w.dueDate, w.dueTime),
    state: w.state,
    extra: {
      url: w.alternateLink ?? null,
      workType: w.workType ?? null,
      maxPoints: w.maxPoints ?? null,
      updatedAt: w.updateTime ?? null,
    },
    attachments: mapMaterials(w.materials),
  };
}

export function mapMaterialPost(courseId: string, m: GcMaterialPost): FetchedItem {
  return {
    courseExternalId: courseId,
    kind: 'MATERIAL',
    externalId: m.id,
    title: m.title ?? 'Material',
    body: m.description,
    publishedAt: date(m.creationTime),
    state: m.state,
    extra: { url: m.alternateLink ?? null, updatedAt: m.updateTime ?? null },
    attachments: mapMaterials(m.materials),
  };
}

/** Nota de uma submissão; null se ainda não há nota atribuída. */
export function mapSubmission(
  courseId: string,
  s: GcSubmission,
  work?: { title?: string; maxPoints?: number },
): FetchedGrade | null {
  if (s.assignedGrade === undefined) return null;
  return {
    courseExternalId: courseId,
    itemExternalId: s.courseWorkId,
    externalId: s.id,
    label: work?.title ?? 'Tarefa',
    score: s.assignedGrade,
    maxScore: work?.maxPoints,
    gradedAt: date(s.updateTime),
  };
}
