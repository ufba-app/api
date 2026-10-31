import { GoogleHttp } from '../google/google-http';
import {
  emptyResult,
  type FetchResult,
  type NormalizedCalendarEvent,
  type SourceContext,
  type SyncScope,
} from '../google/types';

const BASE = 'https://www.googleapis.com/calendar/v3';

export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

interface GcEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export function mapEvent(calendarId: string, e: GcEvent): NormalizedCalendarEvent | null {
  const startRaw = e.start?.dateTime ?? e.start?.date;
  if (!startRaw) return null;
  const endRaw = e.end?.dateTime ?? e.end?.date;
  return {
    calendarId,
    externalId: e.id,
    title: e.summary ?? '(sem título)',
    description: e.description ?? null,
    location: e.location ?? null,
    startsAt: new Date(startRaw),
    endsAt: endRaw ? new Date(endRaw) : null,
    allDay: !e.start?.dateTime,
    status: e.status ?? null,
  };
}

export interface CalendarOptions {
  calendarId?: string;
  /** Janela futura em dias (padrão 30). */
  daysAhead?: number;
  now?: () => Date;
}

/** Fonte Google Calendar: eventos próximos. Autenticação: refresh token guardado (cifrado). */
export class CalendarGateway {
  readonly source = 'CALENDAR';
  readonly auth = 'token-guardado' as const;

  constructor(
    private readonly http: GoogleHttp,
    private readonly opts: CalendarOptions = {},
  ) {}

  async fetch(ctx: SourceContext, _scope: SyncScope = { type: 'all' }): Promise<FetchResult> {
    const calendarId = this.opts.calendarId ?? 'primary';
    const now = (this.opts.now ?? (() => new Date()))();
    const max = new Date(now.getTime() + (this.opts.daysAhead ?? 30) * 86_400_000);

    const raw = await this.http.list<GcEvent>(
      ctx.refreshToken,
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      'items',
      {
        timeMin: now.toISOString(),
        timeMax: max.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      },
    );

    const result = emptyResult();
    for (const e of raw) {
      const ev = mapEvent(calendarId, e);
      if (ev) result.events.push(ev);
    }
    return result;
  }
}
