import { GoogleAuth, GoogleHttp } from '../google/google-http';
import { fakeFetch, tokenRoute } from '../../../../test/support/fake-fetch';
import { CalendarGateway } from './calendar.gateway';

describe('CalendarGateway', () => {
  it('mapeia eventos próximos e usa janela de tempo', async () => {
    const f = fakeFetch([
      tokenRoute,
      {
        match: '/calendars/primary/events',
        body: {
          items: [
            { id: 'e1', summary: 'Prova', location: 'PAF', start: { dateTime: '2026-11-03T13:00:00-03:00' }, end: { dateTime: '2026-11-03T15:00:00-03:00' } },
            { id: 'e2', summary: 'Feriado', start: { date: '2026-11-15' }, end: { date: '2026-11-16' } },
            { id: 'e3' },
          ],
        },
      },
    ]);
    const http = new GoogleHttp(new GoogleAuth({ clientId: 'i', clientSecret: 's', fetchFn: f }), f);
    const gw = new CalendarGateway(http, { now: () => new Date('2026-10-31T00:00:00Z') });
    const r = await gw.fetch({ refreshToken: 'RT' });

    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ externalId: 'e1', title: 'Prova', allDay: false, location: 'PAF' });
    expect(r.events[0].startsAt.toISOString()).toBe('2026-11-03T16:00:00.000Z');
    expect(r.events[1]).toMatchObject({ externalId: 'e2', allDay: true });

    const url = String(f.mock.calls.find(([u]) => String(u).includes('/events'))![0]);
    expect(url).toContain('timeMin=2026-10-31T00%3A00%3A00.000Z');
    expect(url).toContain('singleEvents=true');
  });
});
