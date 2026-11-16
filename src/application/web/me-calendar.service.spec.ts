import type { PublishedCalendarView } from '../calendar/published-calendar';
import { FonteNaoConectadaError, type ContaConectada } from '../live/consulta.service';
import type { PrazoVivo } from '../ports/live-source';
import { MeCalendar, bahiaIso, classifyDeadline, type MeCalendarDeps } from './me-calendar.service';

const Q = { userId: 'u1' };
const NOW = new Date('2026-11-16T12:00:00Z');

function cal(term: string, termStart: string, termEnd: string, nonTeachingDays: PublishedCalendarView['nonTeachingDays'] = []): PublishedCalendarView {
  return { document: { term, publishedOn: null }, keyDates: { termStart, progress25: termStart, progress50: termStart, progress75: termStart, termEnd, internship: null }, nonTeachingDays } as unknown as PublishedCalendarView;
}
const on = (name: string, date: string) => ({ name, when: { type: 'on' as const, date }, weekday: null, dateChanged: false });
const between = (name: string, start: string, end: string) => ({ name, when: { type: 'between' as const, start, end }, weekday: null, dateChanged: false });
const prazo = (id: string, titulo: string, quando: string, tipo?: string, cursoNome?: string): PrazoVivo => ({ id, titulo, quando: new Date(quando), tipo, cursoNome });
const conta = (provider: 'MOODLE' | 'CLASSROOM', c: string, status: ContaConectada['status'] = 'OK'): ContaConectada => ({ provider, conta: c, status });

interface Opts {
  calendars?: PublishedCalendarView[];
  contas?: ContaConectada[];
  prazos?: Record<string, PrazoVivo[] | Error>;
  siasb?: { offered: boolean; status: 'connected' | 'reconnect_required' | 'disconnected' };
  sessions?: Array<{ id: string; disciplineName: string; locationName: string; startAt: Date; endAt: Date; statusLabel: string }>;
  stale?: boolean;
  siasbFails?: boolean;
}
function build(o: Opts = {}) {
  const calls = { prazos: 0, agenda: 0 };
  const deps: MeCalendarDeps = {
    calendars: { all: async () => o.calendars ?? [] },
    consulta: {
      contas: async () => o.contas ?? [],
      prazos: async (_q, _p, c) => {
        calls.prazos++;
        const r = o.prazos?.[c ?? ''] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    siasb: {
      status: async () => o.siasb ?? { offered: false, status: 'disconnected' },
      agenda: async () => {
        calls.agenda++;
        if (o.siasbFails) throw new Error('boom');
        return { stale: o.stale ?? false, items: o.sessions ?? [] };
      },
    },
    now: () => NOW,
  };
  return { svc: new MeCalendar(deps), calls };
}

describe('MeCalendar: validação do intervalo', () => {
  it.each([
    ['2026-11-01', '2026-10-31'],
    ['2026-13-01', '2026-13-05'],
    ['2026-02-30', '2026-03-05'],
    ['01/11/2026', '30/11/2026'],
    ['2026-11-01', '2027-02-01'], // mais de 62 dias
  ])('%s → %s é 400 invalid_request', async (from, to) => {
    await expect(build().svc.get(Q, from, to)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('62 dias exatos passam; um dia só também', async () => {
    const { svc } = build();
    await expect(svc.get(Q, '2026-11-01', '2026-12-31')).resolves.toMatchObject({ from: '2026-11-01', to: '2026-12-31' });
    await expect(svc.get(Q, '2026-11-01', '2026-11-01')).resolves.toMatchObject({ days: [] });
  });
});

describe('MeCalendar: feriados e semestre', () => {
  it('sem fontes e sem calendário: 200 vazio, term null, sources []', async () => {
    expect(await build().svc.get(Q, '2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-01', to: '2026-11-30', term: null, days: [], sources: [] });
  });

  it('sem fontes: só os feriados, com intervalos expandidos e recortados no intervalo; dias vazios não vêm', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Consciência Negra', '2026-11-20'), between('Recesso', '2026-11-29', '2026-12-02')])] });
    const r = await svc.get(Q, '2026-11-18', '2026-12-01');
    expect(r.term).toBe('2026.2');
    expect(r.sources).toEqual([]);
    expect(r.days).toEqual([
      { date: '2026-11-20', nonTeaching: { name: 'Consciência Negra' }, items: [] },
      { date: '2026-11-29', nonTeaching: { name: 'Recesso' }, items: [] },
      { date: '2026-11-30', nonTeaching: { name: 'Recesso' }, items: [] },
      { date: '2026-12-01', nonTeaching: { name: 'Recesso' }, items: [] },
    ]);
  });

  it('o semestre é o que mais cobre o intervalo; feriados de calendários diferentes se somam', async () => {
    const { svc } = build({
      calendars: [cal('2026.1', '2026-03-02', '2026-07-10', [on('Feriado A', '2026-07-09')]), cal('2026.2', '2026-08-17', '2026-12-19', [on('Feriado B', '2026-08-18')])],
    });
    const r = await svc.get(Q, '2026-07-08', '2026-08-19');
    expect(r.term).toBe('2026.2'); // 3 dias de 2026.1 contra 3 de 2026.2: empate fica com o mais novo
    expect(r.days.map((d) => d.date)).toEqual(['2026-07-09', '2026-08-18']);
  });

  it('intervalo no recesso entre semestres: term null, mas feriados de um calendário ainda aparecem', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [between('Recesso', '2026-12-22', '2027-01-05')])] });
    const r = await svc.get(Q, '2026-12-28', '2027-01-03');
    expect(r.term).toBeNull();
    expect(r.days).toHaveLength(7);
  });

  it('dois feriados no mesmo dia: os nomes se juntam; repetido não duplica', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('A', '2026-11-20'), on('B', '2026-11-20'), on('A', '2026-11-20')])] });
    expect((await svc.get(Q, '2026-11-20', '2026-11-20')).days[0].nonTeaching).toEqual({ name: 'A · B' });
  });
});

describe('MeCalendar: entregas e provas', () => {
  it('a API classifica deadline x exam e põe o horário certo (entrega = prazo; prova = início), em fuso de Salvador', async () => {
    const { svc } = build({
      contas: [conta('MOODLE', 'ava:aluno'), conta('CLASSROOM', 'eu@ufba.br')],
      prazos: {
        'ava:aluno': [prazo('1', 'Relatório de prática', '2026-11-18T02:30:00Z', 'tarefa', 'Anatomia'), prazo('2', 'Quiz 3', '2026-11-18T12:00:00Z', 'prova'), prazo('3', 'Prova 2', '2026-11-19T12:00:00Z', 'course')],
        'eu@ufba.br': [prazo('9', 'Lista de exercícios', '2026-11-20T20:00:00Z')],
      },
    });
    const r = await svc.get(Q, '2026-11-15', '2026-11-21');
    expect(r.sources).toEqual([
      { source: 'moodle', status: 'ok' },
      { source: 'classroom', status: 'ok' },
    ]);
    const items = r.days.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i })));
    // 02:30Z de 18/11 é 23:30 de 17/11 em Salvador: o DIA do item é o de Salvador.
    expect(items.find((i) => i.title === 'Relatório de prática')).toMatchObject({ date: '2026-11-17', kind: 'deadline', startsAt: null, endsAt: '2026-11-17T23:30:00-03:00', courseName: 'Anatomia', place: 'Moodle', source: 'moodle' });
    expect(items.find((i) => i.title === 'Quiz 3')).toMatchObject({ kind: 'exam', startsAt: '2026-11-18T09:00:00-03:00', endsAt: null });
    expect(items.find((i) => i.title === 'Prova 2')).toMatchObject({ kind: 'exam' });
    expect(items.find((i) => i.title === 'Lista de exercícios')).toMatchObject({ kind: 'deadline', place: 'Classroom', source: 'classroom' });
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('item fora do intervalo não entra; no feriado o prazo continua (e a aula, quando existir, não)', async () => {
    const { svc } = build({
      calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Consciência Negra', '2026-11-20')])],
      contas: [conta('MOODLE', 'ava:aluno')],
      prazos: { 'ava:aluno': [prazo('1', 'Entrega X', '2026-11-20T15:00:00Z', 'tarefa'), prazo('2', 'Entrega fora', '2026-12-30T15:00:00Z', 'tarefa')] },
    });
    const r = await svc.get(Q, '2026-11-15', '2026-11-30');
    expect(r.days).toEqual([expect.objectContaining({ date: '2026-11-20', nonTeaching: { name: 'Consciência Negra' }, items: [expect.objectContaining({ title: 'Entrega X' })] })]);
  });

  it('itens do dia ordenados pelo horário', async () => {
    const { svc } = build({
      contas: [conta('MOODLE', 'a')],
      prazos: { a: [prazo('1', 'Tarde', '2026-11-18T20:00:00Z', 'tarefa'), prazo('2', 'Cedo', '2026-11-18T11:00:00Z', 'tarefa')] },
    });
    expect((await svc.get(Q, '2026-11-18', '2026-11-18')).days[0].items.map((i) => i.title)).toEqual(['Cedo', 'Tarde']);
  });

  it('falha parcial: a fonte que falhou aparece em sources, o resto vem; reconectar é distinto de falha', async () => {
    const { svc } = build({
      contas: [conta('MOODLE', 'ok'), conta('CLASSROOM', 'quebrou'), conta('CLASSROOM', 'velha', 'REAUTH_NEEDED')],
      prazos: { ok: [prazo('1', 'Entrega', '2026-11-18T15:00:00Z', 'tarefa')], quebrou: new Error('502') },
    });
    const r = await svc.get(Q, '2026-11-18', '2026-11-18');
    expect(r.days[0].items).toHaveLength(1);
    // CLASSROOM tem uma conta que falhou e outra a reconectar: reconectar (acionável) ganha.
    expect(r.sources).toEqual([
      { source: 'moodle', status: 'ok' },
      { source: 'classroom', status: 'reconnect_required' },
    ]);
  });

  it('token recusado no meio da consulta vira reconnect_required; erro qualquer vira failed', async () => {
    const a = await build({ contas: [conta('MOODLE', 'x')], prazos: { x: new FonteNaoConectadaError('recusou') } }).svc.get(Q, '2026-11-18', '2026-11-18');
    expect(a.sources).toEqual([{ source: 'moodle', status: 'reconnect_required' }]);
    const b = await build({ contas: [conta('MOODLE', 'x')], prazos: { x: new Error('x') } }).svc.get(Q, '2026-11-18', '2026-11-18');
    expect(b.sources).toEqual([{ source: 'moodle', status: 'failed' }]);
  });

  it('conta REAUTH_NEEDED nem é consultada', async () => {
    const { svc, calls } = build({ contas: [conta('MOODLE', 'x', 'REAUTH_NEEDED')] });
    await svc.get(Q, '2026-11-18', '2026-11-18');
    expect(calls.prazos).toBe(0);
  });
});

describe('MeCalendar: sessões do SIASB', () => {
  const sess = (id: string, startAt: string, statusLabel = 'Confirmado') => ({ id, disciplineName: 'Clínica Integrada I', locationName: 'Sala 3', startAt: new Date(startAt), endAt: new Date(new Date(startAt).getTime() + 3_600_000), statusLabel });

  it('sem acesso/sem conexão: nenhum item session, siasb fora de sources, e nem consulta a cópia', async () => {
    const { svc, calls } = build({ siasb: { offered: false, status: 'disconnected' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] });
    const r = await svc.get(Q, '2026-11-18', '2026-11-18');
    expect(r.days).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(calls.agenda).toBe(0);
  });

  it('oferecido mas não conectado: também não entra', async () => {
    const { svc } = build({ siasb: { offered: true, status: 'disconnected' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] });
    expect((await svc.get(Q, '2026-11-18', '2026-11-18')).sources).toEqual([]);
  });

  it('conectado: sessões marcadas viram session sem dado de paciente, e NÃO são excluídas em feriado', async () => {
    const { svc } = build({
      calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Consciência Negra', '2026-11-20')])],
      siasb: { offered: true, status: 'connected' },
      sessions: [sess('1', '2026-11-20T12:00:00Z'), sess('2', '2026-11-20T15:00:00Z', 'Cancelada'), sess('3', '2026-11-20T16:00:00Z', 'Atendido')],
    });
    const r = await svc.get(Q, '2026-11-20', '2026-11-20');
    expect(r.sources).toEqual([{ source: 'siasb', status: 'ok' }]);
    expect(r.days[0].nonTeaching).toEqual({ name: 'Consciência Negra' });
    expect(r.days[0].items).toEqual([
      { id: 'siasb:1', kind: 'session', source: 'siasb', title: 'Sessão na clínica', courseName: 'Clínica Integrada I', courseCode: null, startsAt: '2026-11-20T09:00:00-03:00', endsAt: '2026-11-20T10:00:00-03:00', place: 'Sala 3' },
    ]);
    // Nada de paciente na saída.
    expect(JSON.stringify(r)).not.toMatch(/paciente|patient/i);
  });

  it('cópia desatualizada: sources.siasb = failed e as sessões guardadas continuam; reconectar vem da conexão', async () => {
    const stale = await build({ siasb: { offered: true, status: 'connected' }, stale: true, sessions: [sess('1', '2026-11-18T12:00:00Z')] }).svc.get(Q, '2026-11-18', '2026-11-18');
    expect(stale.sources).toEqual([{ source: 'siasb', status: 'failed' }]);
    expect(stale.days[0].items).toHaveLength(1);
    const reco = await build({ siasb: { offered: true, status: 'reconnect_required' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] }).svc.get(Q, '2026-11-18', '2026-11-18');
    expect(reco.sources).toEqual([{ source: 'siasb', status: 'reconnect_required' }]);
    expect(reco.days[0].items).toHaveLength(1);
  });

  it('erro ao ler a cópia não derruba a rota: siasb failed', async () => {
    const r = await build({ siasb: { offered: true, status: 'connected' }, siasbFails: true }).svc.get(Q, '2026-11-18', '2026-11-18');
    expect(r.sources).toEqual([{ source: 'siasb', status: 'failed' }]);
  });
});

describe('MeCalendar: cache', () => {
  it('mesmo intervalo da mesma pessoa vem do cache; outra pessoa ou intervalo não; falha parcial não é guardada', async () => {
    const { svc, calls } = build({ contas: [conta('MOODLE', 'a')], prazos: { a: [] } });
    await svc.get(Q, '2026-11-01', '2026-11-30');
    await svc.get(Q, '2026-11-01', '2026-11-30');
    expect(calls.prazos).toBe(1);
    await svc.get({ userId: 'u2' }, '2026-11-01', '2026-11-30');
    await svc.get(Q, '2026-11-01', '2026-11-29');
    expect(calls.prazos).toBe(3);

    const f = build({ contas: [conta('MOODLE', 'a')], prazos: { a: new Error('x') } });
    await f.svc.get(Q, '2026-11-01', '2026-11-30');
    await f.svc.get(Q, '2026-11-01', '2026-11-30');
    expect(f.calls.prazos).toBe(2);
  });
});

describe('helpers', () => {
  it('bahiaIso usa -03:00', () => expect(bahiaIso(new Date('2026-11-18T12:00:00Z'))).toBe('2026-11-18T09:00:00-03:00'));
  it.each([
    [{ tipo: 'prova', titulo: 'Quiz' }, 'exam'],
    [{ tipo: 'tarefa', titulo: 'Prova 2' }, 'exam'],
    [{ tipo: 'tarefa', titulo: 'Exame final' }, 'exam'],
    [{ tipo: 'tarefa', titulo: 'Relatório' }, 'deadline'],
    [{ tipo: undefined, titulo: 'Aprovação do projeto' }, 'deadline'],
  ] as const)('classifyDeadline %j → %s', (p, k) => expect(classifyDeadline(p)).toBe(k));
});
