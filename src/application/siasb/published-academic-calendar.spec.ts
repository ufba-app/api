import { CalendarLogRepository, type CalendarLogRow } from '../ports/calendar';
import { PublishedAcademicCalendar } from './published-academic-calendar';

type NonTeaching = { name: string; when: { type: 'on'; date: string } | { type: 'between'; start: string; end: string } };

const row = (term: string, termStart: string, termEnd: string, nonTeaching: NonTeaching[], createdAt = '2026-01-01T00:00:00Z') =>
  ({
    id: term + createdAt,
    createdAt: new Date(createdAt),
    term,
    status: 'PUBLISHED',
    contract: {
      keyDates: { termStart, termEnd },
      nonTeachingDays: nonTeaching.map((n) => ({ ...n, weekday: null, dateChanged: false })),
    },
  }) as unknown as CalendarLogRow;

class FakeLogs extends CalendarLogRepository {
  calls = 0;
  fail = false;
  constructor(public rows: CalendarLogRow[]) {
    super();
  }
  async listPublished() {
    this.calls += 1;
    if (this.fail) throw new Error('banco indisponivel 12345678901');
    return this.rows;
  }
  findById = async () => null;
  findBySha = async () => null;
  findErrorByUrl = async () => null;
  create = async (): Promise<CalendarLogRow> => {
    throw new Error('x');
  };
  update = async (): Promise<CalendarLogRow> => {
    throw new Error('x');
  };
  markSeen = async () => null;
  listUnseenProblems = async () => [];
  knownTerms = async () => [];
}

// Datas em UTC-3: meio-dia da Bahia = 15:00Z.
const at = (iso: string) => new Date(`${iso}T12:00:00-03:00`);
const T1 = row('2026.1', '2026-03-02', '2026-07-10', [
  { name: 'Tiradentes', when: { type: 'on', date: '2026-04-21' } },
  { name: 'Recesso', when: { type: 'between', start: '2026-05-04', end: '2026-05-06' } },
]);
const T2 = (start = '2026-07-11') => row('2026.2', start, '2026-12-20', [{ name: 'Finados', when: { type: 'on', date: '2026-11-02' } }]);

describe('PublishedAcademicCalendar', () => {
  it('intervalo dentro de um semestre: feriado e recesso, known true', async () => {
    const cal = new PublishedAcademicCalendar(new FakeLogs([T1]));
    expect(await cal.holidays(at('2026-04-01'), at('2026-05-30'))).toEqual({
      known: true,
      dates: ['2026-04-21', '2026-05-04', '2026-05-05', '2026-05-06'],
    });
  });

  it('não devolve datas fora do intervalo pedido', async () => {
    const cal = new PublishedAcademicCalendar(new FakeLogs([T1]));
    expect(await cal.holidays(at('2026-04-22'), at('2026-05-05'))).toEqual({ known: true, dates: ['2026-05-04', '2026-05-05'] });
  });

  it('intervalo que sai do semestre: known false, feriados de dentro ainda listados', async () => {
    const cal = new PublishedAcademicCalendar(new FakeLogs([T1]));
    expect(await cal.holidays(at('2026-07-01'), at('2026-07-20'))).toEqual({ known: false, dates: [] });
    expect(await cal.holidays(at('2026-04-20'), at('2026-08-01'))).toEqual({
      known: false,
      dates: ['2026-04-21', '2026-05-04', '2026-05-05', '2026-05-06'],
    });
  });

  it('intervalo no vão entre dois semestres: known false', async () => {
    const cal = new PublishedAcademicCalendar(new FakeLogs([T1, T2('2026-08-03')]));
    expect(await cal.holidays(at('2026-07-15'), at('2026-07-25'))).toEqual({ known: false, dates: [] });
  });

  it('dois semestres contíguos cobrem o intervalo; com um dia de vão, não', async () => {
    const contiguous = new PublishedAcademicCalendar(new FakeLogs([T1, T2('2026-07-11')]));
    const r = await contiguous.holidays(at('2026-07-01'), at('2026-11-10'));
    expect(r.known).toBe(true);
    expect(r.dates).toEqual(['2026-11-02']);
    const gap = new PublishedAcademicCalendar(new FakeLogs([T1, T2('2026-07-12')]));
    expect((await gap.holidays(at('2026-07-01'), at('2026-11-10'))).known).toBe(false);
  });

  it('sem calendário, from > to ou linhas sem contrato: known false, sem datas', async () => {
    expect(await new PublishedAcademicCalendar(new FakeLogs([])).holidays(at('2026-04-01'), at('2026-04-02'))).toEqual({ known: false, dates: [] });
    const nulls = { ...T1, contract: null } as unknown as CalendarLogRow;
    expect(await new PublishedAcademicCalendar(new FakeLogs([nulls])).holidays(at('2026-04-01'), at('2026-04-02'))).toEqual({ known: false, dates: [] });
    expect(await new PublishedAcademicCalendar(new FakeLogs([T1])).holidays(at('2026-04-10'), at('2026-04-01'))).toEqual({ known: false, dates: [] });
  });

  it('erro do repositório: known false, sem lançar e sem escrever em stdout/stderr', async () => {
    const logs = new FakeLogs([T1]);
    logs.fail = true;
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await new PublishedAcademicCalendar(logs).holidays(at('2026-04-01'), at('2026-04-30'))).toEqual({ known: false, dates: [] });
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('cache de 60 s', async () => {
    const logs = new FakeLogs([T1]);
    let now = new Date('2026-04-01T12:00:00Z');
    const cal = new PublishedAcademicCalendar(logs, () => now);
    await cal.holidays(at('2026-04-01'), at('2026-04-30'));
    now = new Date(now.getTime() + 59_000);
    await cal.holidays(at('2026-05-01'), at('2026-05-30'));
    expect(logs.calls).toBe(1);
    now = new Date(now.getTime() + 2_000);
    await cal.holidays(at('2026-05-01'), at('2026-05-30'));
    expect(logs.calls).toBe(2);
  });

  it('mesmo semestre duas vezes: vale o createdAt mais recente', async () => {
    const old = row('2026.1', '2026-03-02', '2026-07-10', [{ name: 'Velho', when: { type: 'on', date: '2026-04-21' } }], '2026-01-01T00:00:00Z');
    const fresh = row('2026.1', '2026-03-02', '2026-07-10', [{ name: 'Novo', when: { type: 'on', date: '2026-04-22' } }], '2026-02-01T00:00:00Z');
    const cal = new PublishedAcademicCalendar(new FakeLogs([fresh, old]));
    expect((await cal.holidays(at('2026-04-01'), at('2026-04-30'))).dates).toEqual(['2026-04-22']);
  });
});
