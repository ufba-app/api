import { InMemoryCalendarLogs, perfectCalendar } from '../../../test/support/calendar-fake';
import { PublishedCalendarResponse } from '../web/contract';
import type { NewCalendarLog } from '../ports/calendar';
import { PublishedCalendar } from './published-calendar';

let n = 0;
const sha = () => String(++n).padStart(64, '0');

const published = (term: string, termStart: string, termEnd: string, url = `https://supac.ufba.br/${term}.pdf`): NewCalendarLog => {
  const c = perfectCalendar();
  c.document.term = term;
  c.keyDates.termStart = termStart;
  c.keyDates.termEnd = termEnd;
  return {
    sourceUrl: url,
    sourceSha256: sha(),
    term,
    status: 'PUBLISHED',
    verified: true,
    warnings: [],
    contract: { ...c, contractVersion: '1', verification: { verified: true, warnings: ['interno'], reader: 'ai' } },
    model: null,
    inputTokens: null,
    outputTokens: null,
  };
};

async function make(today: string) {
  const logs = new InMemoryCalendarLogs();
  await logs.create(published('2026.1', '2026-03-02', '2026-07-04'));
  await logs.create(published('2026.2', '2026-08-19', '2026-12-19'));
  return { logs, calendar: new PublishedCalendar(logs, () => new Date(`${today}T15:00:00Z`)) };
}

describe('PublishedCalendar', () => {
  it('sem term devolve o semestre vigente (o que contém hoje), sem a conferência interna', async () => {
    const { calendar } = await make('2026-05-10');
    const c = await calendar.get();
    expect(c.document.term).toBe('2026.1');
    expect(c).not.toHaveProperty('verification');
    expect(JSON.stringify(c)).not.toContain('interno');
    expect(c.sourceUrl).toBe('https://supac.ufba.br/2026.1.pdf');
    expect(c.publishedAt).toBeInstanceOf(Date);
  });

  it('entre dois semestres, o próximo a começar; depois de todos, o mais recente', async () => {
    expect((await (await make('2026-07-20')).calendar.get()).document.term).toBe('2026.2');
    expect((await (await make('2027-02-01')).calendar.get()).document.term).toBe('2026.2');
  });

  it('com term devolve aquele semestre; semestre sem publicação é 404', async () => {
    const { calendar } = await make('2026-11-15');
    expect((await calendar.get('2026.1')).document.term).toBe('2026.1');
    await expect(calendar.get('2030.1')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('nenhum calendário publicado: 404', async () => {
    await expect(new PublishedCalendar(new InMemoryCalendarLogs()).get()).rejects.toMatchObject({ status: 404 });
  });

  it('reedição do mesmo semestre: vale a mais recente', async () => {
    const { logs, calendar } = await make('2026-11-15');
    await logs.create(published('2026.2', '2026-08-19', '2026-12-19', 'https://supac.ufba.br/2026.2-reedicao.pdf'));
    expect((await calendar.get('2026.2')).sourceUrl).toBe('https://supac.ufba.br/2026.2-reedicao.pdf');
  });

  it('o corpo (como a rota o devolve) valida contra o schema do contrato do web', async () => {
    const { calendar } = await make('2026-11-15');
    const c = await calendar.get();
    const body = { ...c, publishedAt: c.publishedAt.toISOString() };
    expect(PublishedCalendarResponse.safeParse(body).success).toBe(true);
  });
});
