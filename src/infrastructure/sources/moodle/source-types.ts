/**
 * Forma da porta SourceGateway usada pelo Moodle.
 * Provisória: quando o Núcleo publicar `application/ports/source-gateway.ts`, trocar estes tipos por import de lá
 * (os campos seguem o schema Prisma de `Item`, `Attachment`, `CourseSpace`, `GradeEntry` e `CalendarEvent`).
 */
export type ItemKind =
  | 'ANNOUNCEMENT'
  | 'ASSIGNMENT'
  | 'ASSESSMENT'
  | 'MATERIAL'
  | 'FORUM_TOPIC'
  | 'OTHER';

export interface SourceContext {
  /** Raiz do Moodle da conta, ex.: https://ava.ufba.br */
  baseUrl: string;
  /** wstoken já decifrado pela plataforma. Nunca logar. */
  token: string;
}

export type SyncScope =
  | { kind: 'all' }
  | { kind: 'course'; courseExternalId: string }
  | { kind: 'item'; courseExternalId: string; itemExternalId: string };

export interface FetchedAttachment {
  externalId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  /** URL na fonte, sem token. O conteúdo é lido sob demanda por AttachmentReader. */
  sourceUrl: string;
}

export interface FetchedCourseSpace {
  externalId: string;
  name: string;
  extra?: Record<string, unknown>;
}

export interface FetchedItem {
  courseExternalId: string;
  kind: ItemKind;
  externalId: string;
  title: string;
  body?: string;
  dueAt?: Date;
  publishedAt?: Date;
  state?: string;
  extra?: Record<string, unknown>;
  contentHash: string;
  attachments: FetchedAttachment[];
}

export interface FetchedGrade {
  courseExternalId: string;
  externalId: string;
  label: string;
  score?: number;
  maxScore?: number;
  weight?: number;
  gradedAt?: Date;
  contentHash: string;
}

export interface FetchedEvent {
  courseExternalId?: string;
  externalId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt?: Date;
  kind?: string;
  contentHash: string;
}

export interface SourceFetchResult {
  courseSpaces: FetchedCourseSpace[];
  items: FetchedItem[];
  grades: FetchedGrade[];
  events: FetchedEvent[];
}

export interface SourceGateway {
  readonly source: 'MOODLE';
  /** Moodle guarda token (cifrado pela plataforma); nunca segredo por requisição. */
  readonly auth: 'token-guardado';
  fetch(ctx: SourceContext, scope: SyncScope): Promise<SourceFetchResult>;
}

export interface AttachmentReader {
  read(
    ctx: SourceContext,
    sourceUrl: string,
  ): Promise<{ content: Buffer; mimeType: string; fileName?: string }>;
}
