import { GoogleHttp } from '../google/google-http';
import type {
  FetchedEvent,
  SourceContext,
  SourceFetchResult,
  SourceGateway,
  SyncScope,
} from '../../../application/ports/source-gateway';
import { refreshTokenOf, translateErrors } from '../google/google-errors';

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

export function mapEvent(calendarId: string, e: GcEvent): FetchedEvent | null {
  const startRaw = e.start?.dateTime ?? e.start?.date;
  if (!startRaw) return null;
  const endRaw = e.end?.dateTime ?? e.end?.date;
  return {
    calendarId,
    externalId: e.id,
    title: e.summary ?? '(sem título)',
    description: e.description,
    location: e.location,
    startsAt: new Date(startRaw),
    endsAt: endRaw ? new Date(endRaw) : undefined,
    allDay: !e.start?.dateTime,
    status: e.status,
  };
}

export interface CalendarOptions {
  calendarId?: string;
  /** Janela futura em dias (padrão 30). */
  daysAhead?: number;
  now?: () => Date;
}

/** Fonte Google Calendar: eventos próximos. Autenticação: refresh token guardado (cifrado). */
export class CalendarGateway implements SourceGateway {
  readonly provider = 'CALENDAR' as const;
  readonly auth = 'token-guardado' as const;

  constructor(
    private readonly http: GoogleHttp,
    private readonly opts: CalendarOptions = {},
  ) {}

  async fetch(ctx: SourceContext, _scope: SyncScope = { kind: 'tudo' }): Promise<SourceFetchResult> {
    return translateErrors(() => this.doFetch(ctx));
  }

  private async doFetch(ctx: SourceContext): Promise<SourceFetchResult> {
    const calendarId = this.opts.calendarId ?? 'primary';
    const now = (this.opts.now ?? (() => new Date()))();
    const max = new Date(now.getTime() + (this.opts.daysAhead ?? 30) * 86_400_000);

    const raw = await this.http.list<GcEvent>(
      refreshTokenOf(ctx),
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

    const events: FetchedEvent[] = [];
    for (const e of raw) {
      const ev = mapEvent(calendarId, e);
      if (ev) events.push(ev);
    }
    return { events };
  }
}
