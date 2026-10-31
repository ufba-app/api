/**
 * Formato de retorno dos gateways Google, na forma do CONTRATO
 * (fetch(ctx, scope) -> {items, courseSpaces, events...}).
 * TODO: trocar por imports de application/ports/source-gateway.ts quando o Núcleo publicá-lo.
 */
export type ItemKind = 'ANNOUNCEMENT' | 'ASSIGNMENT' | 'ASSESSMENT' | 'MATERIAL' | 'FORUM_TOPIC' | 'OTHER';

export interface SourceContext {
  /** Refresh token em texto claro (decifrado pelo chamador com SecretBox). */
  refreshToken: string;
}

export type SyncScope =
  | { type: 'all' }
  | { type: 'course'; courseId: string }
  | { type: 'item'; courseId: string; itemId: string };

export interface NormalizedAttachment {
  externalId: string | null;
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  extra?: Record<string, unknown>;
}

export interface NormalizedItem {
  externalId: string;
  courseExternalId: string;
  kind: ItemKind;
  title: string;
  body: string | null;
  url: string | null;
  publishedAt: Date | null;
  dueAt: Date | null;
  attachments: NormalizedAttachment[];
  extra: Record<string, unknown>;
}

export interface NormalizedCourseSpace {
  externalId: string;
  name: string;
  extra: Record<string, unknown>;
}

export interface NormalizedGrade {
  externalId: string;
  courseExternalId: string;
  itemExternalId: string | null;
  label: string;
  score: number | null;
  maxScore: number | null;
  gradedAt: Date | null;
}

export interface NormalizedCalendarEvent {
  calendarId: string;
  externalId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  status: string | null;
}

export interface FetchResult {
  courseSpaces: NormalizedCourseSpace[];
  items: NormalizedItem[];
  grades: NormalizedGrade[];
  events: NormalizedCalendarEvent[];
}

export const emptyResult = (): FetchResult => ({ courseSpaces: [], items: [], grades: [], events: [] });
