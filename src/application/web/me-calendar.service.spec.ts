import type { PublishedCalendarView } from '../calendar/published-calendar';
import type { ClassSchedule } from '../../domain/academic/class-schedule';
import { parseSchedule } from '../../domain/academic/class-schedule';
import { FonteNaoConectadaError } from '../live/consulta.service';
import { MeCalendar, bahiaIso, type MeCalendarDeps, type SigaaState } from './me-calendar.service';

const Q = { userId: 'u1' };
const NOW = new Date('2026-11-16T12:00:00Z');

function cal(term: string, termStart: string, termEnd: string, nonTeachingDays: PublishedCalendarView['nonTeachingDays'] = []): PublishedCalendarView {
  return { document: { term, publishedOn: null }, keyDates: { termStart, progress25: termStart, progress50: termStart, progress75: termStart, termEnd, internship: null }, nonTeachingDays } as unknown as PublishedCalendarView;
}
const on = (name: string, date: string) => ({ name, when: { type: 'on' as const, date }, weekday: null, dateChanged: false });
const between = (name: string, start: string, end: string) => ({ name, when: { type: 'between' as const, start, end }, weekday: null, dateChanged: false });

function turma(name: string, code: string, place: string | null = 'Sala 12', courseCode: string | null = null): ClassSchedule {
  const parsed = parseSchedule(code)!;
  const placeByWeekday = Object.fromEntries(parsed.blocks.flatMap((b) => b.weekdays).map((d) => [d, place]));
  return { name, courseCode, semester: '2026.2', placeByWeekday, code, ...parsed };
}

interface Opts {
  calendars?: PublishedCalendarView[];
  turmas?: ClassSchedule[] | Error;
  siasb?: { offered: boolean; status: 'connected' | 'reconnect_required' | 'disconnected' };
  sessions?: Array<{ id: string; disciplineName: string; locationName: string; startAt: Date; endAt: Date; statusLabel: string }>;
  stale?: boolean;
  siasbFails?: boolean;
}
function build(o: Opts = {}) {
  const calls = { turmas: 0, agenda: 0 };
  const deps: MeCalendarDeps = {
    calendars: { all: async () => o.calendars ?? [] },
    sigaa: {
      turmas: async () => {
        calls.turmas++;
        if (o.turmas instanceof Error) throw o.turmas;
        return o.turmas ?? [];
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
const get = (svc: MeCalendar, from: string, to: string, sigaa: SigaaState = 'connected') => svc.get(Q, from, to, sigaa);

describe('MeCalendar: validação do intervalo', () => {
  it.each([
    ['2026-11-01', '2026-10-31'],
    ['2026-13-01', '2026-13-05'],
    ['2026-02-30', '2026-03-05'],
    ['01/11/2026', '30/11/2026'],
    ['2026-11-01', '2027-02-01'], // mais de 62 dias
  ])('%s → %s é 400 invalid_request', async (from, to) => {
    await expect(get(build().svc, from, to)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('62 dias exatos passam; um dia só também', async () => {
    const { svc } = build();
    await expect(get(svc, '2026-11-01', '2026-12-31')).resolves.toMatchObject({ from: '2026-11-01', to: '2026-12-31' });
    await expect(get(svc, '2026-11-01', '2026-11-01')).resolves.toMatchObject({ days: [] });
  });
});

describe('MeCalendar: feriados e semestre', () => {
  it('sem fontes e sem calendário: 200 vazio, term null, sources []', async () => {
    expect(await get(build().svc, '2026-11-01', '2026-11-30', 'disconnected')).toEqual({ from: '2026-11-01', to: '2026-11-30', term: null, days: [], sources: [] });
  });

  it('sem fontes: só os feriados, com intervalos expandidos e recortados no intervalo; dias vazios não vêm', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Consciência Negra', '2026-11-20'), between('Recesso', '2026-11-29', '2026-12-02')])] });
    const r = await get(svc, '2026-11-18', '2026-12-01', 'disconnected');
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
    const r = await get(svc, '2026-07-08', '2026-08-19', 'disconnected');
    expect(r.term).toBe('2026.2'); // 3 dias de 2026.1 contra 3 de 2026.2: empate fica com o mais novo
    expect(r.days.map((d) => d.date)).toEqual(['2026-07-09', '2026-08-18']);
  });

  it('intervalo no recesso entre semestres: term null, mas feriados de um calendário ainda aparecem', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [between('Recesso', '2026-12-22', '2027-01-05')])] });
    const r = await get(svc, '2026-12-28', '2027-01-03', 'disconnected');
    expect(r.term).toBeNull();
    expect(r.days).toHaveLength(7);
  });

  it('dois feriados no mesmo dia: os nomes se juntam; repetido não duplica', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('A', '2026-11-20'), on('B', '2026-11-20'), on('A', '2026-11-20')])] });
    expect((await get(svc, '2026-11-20', '2026-11-20', 'disconnected')).days[0].nonTeaching).toEqual({ name: 'A · B' });
  });
});

describe('MeCalendar: aulas (recorrência do SIGAA)', () => {
  // 2026-11-17 é terça; 2026-11-19 é quinta.
  const SO = turma('SISTEMAS OPERACIONAIS', '35T45 (18/08/2026 - 19/12/2026)', 'Sala 12');

  it('35T45 = terça e quinta, 4º e 5º módulos da tarde (13:00 + 3×55 min = 15:45 às 17:35), na sala do portal', async () => {
    const { svc } = build({ turmas: [SO] });
    const r = await get(svc, '2026-11-16', '2026-11-22');
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'ok' }]);
    expect(r.days.map((d) => d.date)).toEqual(['2026-11-17', '2026-11-19']);
    expect(r.days[0].items).toEqual([
      { id: 'sigaa:sistemas-operacionais:2026-11-17:1545', kind: 'class', source: 'sigaa', title: 'SISTEMAS OPERACIONAIS', courseName: 'SISTEMAS OPERACIONAIS', courseCode: null, startsAt: '2026-11-17T15:45:00-03:00', endsAt: '2026-11-17T17:35:00-03:00', place: 'Sala 12' },
    ]);
  });

  it('exclui as aulas dos feriados e dias sem aula (o dia sai com nonTeaching e sem class)', async () => {
    const { svc } = build({ calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Feriado', '2026-11-19'), between('Recesso', '2026-11-23', '2026-11-28')])], turmas: [SO] });
    const r = await get(svc, '2026-11-16', '2026-12-01');
    const dia = (d: string) => r.days.find((x) => x.date === d)!;
    expect(dia('2026-11-17').items).toHaveLength(1);
    expect(dia('2026-11-19')).toMatchObject({ nonTeaching: { name: 'Feriado' }, items: [] });
    expect(r.days.filter((d) => d.date >= '2026-11-23' && d.date <= '2026-11-28').every((d) => d.items.length === 0)).toBe(true);
    expect(dia('2026-11-24').items).toEqual([]); // terça no recesso
    expect(dia('2026-12-01').items).toHaveLength(1); // volta depois do recesso
  });

  it('respeita o período da turma (antes do início e depois do fim não há aula)', async () => {
    const t = turma('CURTA', '3M12 (10/11/2026 - 24/11/2026)');
    const r = await get(build({ turmas: [t] }).svc, '2026-11-01', '2026-12-15');
    expect(r.days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-17', '2026-11-24']);
  });

  it('sem período no portal: vale o semestre do calendário publicado; sem calendário também, nada é inventado', async () => {
    const t = turma('SEM PERIODO', '3M12');
    expect(t.period).toBeNull();
    const com = await get(build({ calendars: [cal('2026.2', '2026-11-10', '2026-11-24')], turmas: [t] }).svc, '2026-11-01', '2026-12-15');
    expect(com.days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-17', '2026-11-24']);
    const sem = await get(build({ turmas: [t] }).svc, '2026-11-01', '2026-12-15');
    expect(sem.days).toEqual([]);
    expect(sem.sources).toEqual([{ source: 'sigaa', status: 'ok' }]);
  });

  it('vários blocos ("24M12 6T12"), turno da noite e módulos não contínuos', async () => {
    const r = await get(build({ turmas: [turma('A', '24M12 6T12 (01/11/2026 - 30/11/2026)'), turma('B', '2N12 (01/11/2026 - 30/11/2026)'), turma('C', '3M13 (01/11/2026 - 30/11/2026)')] }).svc, '2026-11-16', '2026-11-22');
    const hoje = (d: string) => r.days.find((x) => x.date === d)!.items.map((i) => `${i.title} ${i.startsAt!.slice(11, 16)}-${i.endsAt!.slice(11, 16)}`);
    expect(hoje('2026-11-16')).toEqual(['A 07:00-08:50', 'B 18:30-20:20']); // segunda
    expect(hoje('2026-11-17')).toEqual(['C 07:00-07:55', 'C 08:50-09:45']); // terça: módulos 1 e 3 são dois trechos
    expect(hoje('2026-11-18')).toEqual(['A 07:00-08:50']); // quarta
    expect(hoje('2026-11-20')).toEqual(['A 13:00-14:50']); // sexta
  });

  it('aulas e sessões do SIASB no mesmo dia vêm ordenadas pelo horário', async () => {
    const { svc } = build({
      turmas: [SO],
      siasb: { offered: true, status: 'connected' },
      sessions: [{ id: 's1', disciplineName: 'Clínica', locationName: 'Sala 3', startAt: new Date('2026-11-17T12:00:00Z'), endAt: new Date('2026-11-17T13:00:00Z'), statusLabel: 'Confirmado' }],
    });
    const r = await get(svc, '2026-11-17', '2026-11-17');
    expect(r.days[0].items.map((i) => [i.kind, i.startsAt!.slice(11, 16)])).toEqual([['session', '09:00'], ['class', '15:45']]);
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'ok' }, { source: 'siasb', status: 'ok' }]);
  });

  it('SIGAA desconectado: sem aulas e sem sigaa em sources, e nem consulta o portal', async () => {
    const { svc, calls } = build({ turmas: [SO] });
    const r = await get(svc, '2026-11-16', '2026-11-22', 'disconnected');
    expect(r.days).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(calls.turmas).toBe(0);
  });

  it.each(['password_required', 'locked'] as const)('SIGAA %s: sigaa vira reconnect_required, sem consultar o portal', async (state) => {
    const { svc, calls } = build({ turmas: [SO] });
    const r = await get(svc, '2026-11-16', '2026-11-22', state);
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'reconnect_required' }]);
    expect(calls.turmas).toBe(0);
  });

  it('falha ao ler o portal: sigaa failed (ou reconnect_required se a conta recusou), o resto da rota segue', async () => {
    const cal1 = [cal('2026.2', '2026-08-17', '2026-12-19', [on('Feriado', '2026-11-20')])];
    const a = await get(build({ calendars: cal1, turmas: new Error('página inesperada') }).svc, '2026-11-16', '2026-11-22');
    expect(a.sources).toEqual([{ source: 'sigaa', status: 'failed' }]);
    expect(a.days).toEqual([{ date: '2026-11-20', nonTeaching: { name: 'Feriado' }, items: [] }]);
    const b = await get(build({ turmas: new FonteNaoConectadaError('recusou') }).svc, '2026-11-16', '2026-11-22');
    expect(b.sources).toEqual([{ source: 'sigaa', status: 'reconnect_required' }]);
  });

  it('não há entregas nem provas: nenhum item kind deadline/exam e nenhuma fonte moodle/classroom', async () => {
    const r = await get(build({ turmas: [SO] }).svc, '2026-11-16', '2026-11-22');
    expect(r.days.flatMap((d) => d.items).every((i) => i.kind === 'class' || i.kind === 'session')).toBe(true);
    expect(r.sources.every((s) => s.source === 'sigaa' || s.source === 'siasb')).toBe(true);
  });
});

describe('MeCalendar: sessões do SIASB', () => {
  const sess = (id: string, startAt: string, statusLabel = 'Confirmado') => ({ id, disciplineName: 'Clínica Integrada I', locationName: 'Sala 3', startAt: new Date(startAt), endAt: new Date(new Date(startAt).getTime() + 3_600_000), statusLabel });

  it('sem acesso/sem conexão: nenhum item session, siasb fora de sources, e nem consulta a cópia', async () => {
    const { svc, calls } = build({ siasb: { offered: false, status: 'disconnected' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] });
    const r = await get(svc, '2026-11-18', '2026-11-18', 'disconnected');
    expect(r.days).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(calls.agenda).toBe(0);
  });

  it('oferecido mas não conectado: também não entra', async () => {
    const { svc } = build({ siasb: { offered: true, status: 'disconnected' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] });
    expect((await get(svc, '2026-11-18', '2026-11-18', 'disconnected')).sources).toEqual([]);
  });

  it('conectado: sessões marcadas viram session sem dado de paciente, e NÃO são excluídas em feriado', async () => {
    const { svc } = build({
      calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Consciência Negra', '2026-11-20')])],
      siasb: { offered: true, status: 'connected' },
      sessions: [sess('1', '2026-11-20T12:00:00Z'), sess('2', '2026-11-20T15:00:00Z', 'Cancelada'), sess('3', '2026-11-20T16:00:00Z', 'Atendido')],
    });
    const r = await get(svc, '2026-11-20', '2026-11-20', 'disconnected');
    expect(r.sources).toEqual([{ source: 'siasb', status: 'ok' }]);
    expect(r.days[0].nonTeaching).toEqual({ name: 'Consciência Negra' });
    expect(r.days[0].items).toEqual([
      { id: 'siasb:1', kind: 'session', source: 'siasb', title: 'Sessão na clínica', courseName: 'Clínica Integrada I', courseCode: null, startsAt: '2026-11-20T09:00:00-03:00', endsAt: '2026-11-20T10:00:00-03:00', place: 'Sala 3' },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/paciente|patient/i);
  });

  it('cópia desatualizada: sources.siasb = failed e as sessões guardadas continuam; reconectar vem da conexão', async () => {
    const stale = await get(build({ siasb: { offered: true, status: 'connected' }, stale: true, sessions: [sess('1', '2026-11-18T12:00:00Z')] }).svc, '2026-11-18', '2026-11-18', 'disconnected');
    expect(stale.sources).toEqual([{ source: 'siasb', status: 'failed' }]);
    expect(stale.days[0].items).toHaveLength(1);
    const reco = await get(build({ siasb: { offered: true, status: 'reconnect_required' }, sessions: [sess('1', '2026-11-18T12:00:00Z')] }).svc, '2026-11-18', '2026-11-18', 'disconnected');
    expect(reco.sources).toEqual([{ source: 'siasb', status: 'reconnect_required' }]);
    expect(reco.days[0].items).toHaveLength(1);
  });

  it('erro ao ler a cópia não derruba a rota: siasb failed', async () => {
    const r = await get(build({ siasb: { offered: true, status: 'connected' }, siasbFails: true }).svc, '2026-11-18', '2026-11-18', 'disconnected');
    expect(r.sources).toEqual([{ source: 'siasb', status: 'failed' }]);
  });
});

describe('MeCalendar: cache', () => {
  it('mesmo intervalo da mesma pessoa vem do cache; outra pessoa, intervalo ou estado do SIGAA não; falha parcial não é guardada', async () => {
    const { svc, calls } = build({ turmas: [] });
    await get(svc, '2026-11-01', '2026-11-30');
    await get(svc, '2026-11-01', '2026-11-30');
    expect(calls.turmas).toBe(1);
    await svc.get({ userId: 'u2' }, '2026-11-01', '2026-11-30', 'connected');
    await get(svc, '2026-11-01', '2026-11-29');
    expect(calls.turmas).toBe(3);

    const f = build({ turmas: new Error('x') });
    await get(f.svc, '2026-11-01', '2026-11-30');
    await get(f.svc, '2026-11-01', '2026-11-30');
    expect(f.calls.turmas).toBe(2);
  });
});

describe('helpers', () => {
  it('bahiaIso usa -03:00', () => expect(bahiaIso(new Date('2026-11-18T12:00:00Z'))).toBe('2026-11-18T09:00:00-03:00'));
});
