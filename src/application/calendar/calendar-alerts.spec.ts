import { InMemoryCalendarLogs, perfectCalendar } from '../../../test/support/calendar-fake';
import type { NewCalendarLog } from '../ports/calendar';
import { ApiError } from '../web/web-api';
import { CalendarAlertService, currentTerm, todayInBahia } from './calendar-alerts';

const base: NewCalendarLog = { sourceUrl: 'u', sourceSha256: null, term: null, status: 'ERROR', verified: null, warnings: ['x'], contract: null, model: null, inputTokens: null, outputTokens: null };
let n = 0;
const sha = () => String(++n).padStart(64, '0');

/** Calendário publicado de `term`, com o período dado. */
const published = (term: string, termStart: string, termEnd: string): NewCalendarLog => {
  const c = perfectCalendar();
  c.document.term = term;
  c.keyDates.termStart = termStart;
  c.keyDates.termEnd = termEnd;
  return { ...base, sourceSha256: sha(), term, status: 'PUBLISHED', verified: true, warnings: [], contract: { ...c, contractVersion: '1', verification: { verified: true, warnings: [], reader: 'ai' } } };
};

function make(today = '2026-11-15') {
  const logs = new InMemoryCalendarLogs();
  const admins = { require: jest.fn(async (id: string) => { if (id !== 'admin') throw new ApiError(403, 'not_admin', 'Só administradores podem fazer isso.'); }) };
  const service = new CalendarAlertService(logs, admins, () => new Date(`${today}T15:00:00Z`));
  return { logs, service };
}

describe('currentTerm', () => {
  const spans = [
    { term: '2026.1', termStart: '2026-03-02', termEnd: '2026-07-04' },
    { term: '2026.2', termStart: '2026-08-19', termEnd: '2026-12-19' },
  ];
  it('o semestre cujo período contém hoje', () => expect(currentTerm(spans, '2026-05-10')).toBe('2026.1'));
  it('entre dois semestres, o próximo a começar', () => expect(currentTerm(spans, '2026-07-20')).toBe('2026.2'));
  it('depois de todos, o mais recente', () => expect(currentTerm(spans, '2027-01-10')).toBe('2026.2'));
  it('sem calendário publicado, nenhum', () => expect(currentTerm([], '2026-05-10')).toBeNull());
});

describe('todayInBahia', () => {
  it('usa o dia de Salvador (UTC-3), não o UTC', () => {
    expect(todayInBahia(new Date('2026-11-16T01:30:00Z'))).toBe('2026-11-15');
  });
});

describe('CalendarAlertService', () => {
  it('só admin vê e marca (403 not_admin)', async () => {
    const { service } = make();
    await expect(service.list('aluno')).rejects.toMatchObject({ code: 'not_admin' });
    await expect(service.markSeen('aluno', '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'not_admin' });
  });

  it('regra: não publicado, não visto e (ERROR ou semestre >= vigente); ERROR da página sempre alerta', async () => {
    const { logs, service } = make();
    await logs.create(published('2026.2', '2026-08-19', '2026-12-19'));
    await logs.create({ ...base, sourceSha256: sha(), term: '2026.2', status: 'NOT_VERIFIED', verified: false }); // alerta
    await logs.create({ ...base, sourceSha256: sha(), term: '2027.1', status: 'NOT_VERIFIED', verified: false }); // futuro: alerta
    await logs.create({ ...base, sourceSha256: sha(), term: '2026.1', status: 'NOT_VERIFIED', verified: false }); // encerrado: não
    await logs.create({ ...base, sourceUrl: 'quebrado-2024.2', term: '2024.2' }); // ERROR de semestre antigo: não
    await logs.create({ ...base, sourceUrl: 'quebrado-2026.2', term: '2026.2' }); // ERROR do vigente: alerta
    await logs.create({ ...base, sourceUrl: 'pagina', term: null }); // página inteira: sempre
    const seen = await logs.create({ ...base, sourceUrl: 'visto', term: '2026.2' });
    await logs.markSeen(seen.id, 'admin', new Date()); // já visto: não

    const { items, expired } = await service.list('admin');
    expect(items.map((i) => `${i.status}:${i.term}`).sort()).toEqual(['ERROR:2026.2', 'ERROR:null', 'NOT_VERIFIED:2026.2', 'NOT_VERIFIED:2027.1']);
    expect(expired).toBeNull();
    expect(JSON.stringify(items)).not.toContain('contract');
  });

  it('sem nenhum calendário publicado, tudo que não está PUBLISHED alerta', async () => {
    const { logs, service } = make();
    await logs.create({ ...base, sourceSha256: sha(), term: '2020.1', status: 'NOT_VERIFIED', verified: false });
    expect((await service.list('admin')).items).toHaveLength(1);
  });

  it('calendário vencido e nada novo: expired', async () => {
    const { logs, service } = make('2027-01-20');
    await logs.create(published('2026.2', '2026-08-19', '2026-12-19'));
    expect((await service.list('admin')).expired).toEqual({ term: '2026.2', termEnd: '2026-12-19' });
  });

  it('"Visto" guarda quem e quando; some do alerta; id desconhecido ou inválido é 404', async () => {
    const { logs, service } = make();
    const row = await logs.create({ ...base, term: null });
    await service.markSeen('admin', row.id);
    expect(logs.rows[0]).toMatchObject({ seen: true, seenBy: 'admin' });
    expect(logs.rows[0]!.seenAt).toBeInstanceOf(Date);
    expect((await service.list('admin')).items).toHaveLength(0);
    await expect(service.markSeen('admin', '00000000-0000-4000-8000-0000000000ff')).rejects.toMatchObject({ status: 404 });
    await expect(service.markSeen('admin', 'não-é-uuid')).rejects.toMatchObject({ status: 404 });
  });
});
