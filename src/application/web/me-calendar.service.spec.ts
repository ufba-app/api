import type { PublishedCalendarView } from '../calendar/published-calendar';
import type { ClassSchedule } from '../../domain/academic/class-schedule';
import { parseSchedule } from '../../domain/academic/class-schedule';
import { FonteNaoConectadaError } from '../live/consulta.service';
import type { PrazoVivo } from '../ports/live-source';
import { MeCalendar, bahiaIso, classifySigaaDeadline, type MeCalendarDeps, type SigaaState } from './me-calendar.service';

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
  prazos?: PrazoVivo[];
  prazosCompletos?: boolean;
  agendaDelay?: () => Promise<void>;
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
      agenda: async () => {
        calls.turmas++; // conta as leituras do SIGAA
        await o.agendaDelay?.();
        if (o.turmas instanceof Error) throw o.turmas;
        return { turmas: o.turmas ?? [], prazos: o.prazos ?? [], prazosCompletos: o.prazosCompletos ?? true };
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

  it('nada de Moodle/Classroom: as fontes são só sigaa e siasb, e deadline/exam só com source sigaa', async () => {
    const r = await get(build({ turmas: [SO], prazos: [{ id: 'a:avaliacao:0', titulo: 'Prova', quando: new Date('2026-11-18T12:00:00Z'), cursoId: 'a', cursoNome: 'A', tipo: 'prova' }] }).svc, '2026-11-16', '2026-11-22');
    expect(r.sources.every((s) => s.source === 'sigaa' || s.source === 'siasb')).toBe(true);
    for (const i of r.days.flatMap((d) => d.items)) if (i.kind === 'deadline' || i.kind === 'exam') expect(i.source).toBe('sigaa');
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
    // Outra pessoa lê o SIGAA de novo; outro intervalo da MESMA pessoa reaproveita a leitura do SIGAA (12 min por pessoa).
    expect(calls.turmas).toBe(2);

    const f = build({ turmas: new Error('x') });
    await get(f.svc, '2026-11-01', '2026-11-30');
    await get(f.svc, '2026-11-01', '2026-11-30');
    expect(f.calls.turmas).toBe(2);
  });
});

describe('helpers', () => {
  it('bahiaIso usa -03:00', () => expect(bahiaIso(new Date('2026-11-18T12:00:00Z'))).toBe('2026-11-18T09:00:00-03:00'));
});

const prazo = (id: string, titulo: string, quando: string, cursoNome = 'ANATOMIA'): PrazoVivo => ({ id, titulo, quando: new Date(quando), cursoId: 'anatomia', cursoNome, tipo: 'prova' });

describe('MeCalendar: prazos do SIGAA (avaliações com data)', () => {
  const SO = turma('SISTEMAS OPERACIONAIS', '35T45 (18/08/2026 - 19/12/2026)');

  it('prova = exam (começa na hora); trabalho/entrega = deadline (termina no prazo); só source sigaa', async () => {
    const { svc } = build({
      turmas: [SO],
      prazos: [prazo('anatomia:avaliacao:0', 'Prova 2', '2026-11-18T12:00:00Z'), prazo('anatomia:avaliacao:1', 'Entrega do relatório final', '2026-11-20T02:00:00Z')],
    });
    const r = await get(svc, '2026-11-16', '2026-11-22');
    const itens = r.days.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i })));
    expect(itens.find((i) => i.title === 'Prova 2')).toEqual({ date: '2026-11-18', id: 'sigaa:anatomia:avaliacao:0', kind: 'exam', source: 'sigaa', title: 'Prova 2', courseName: 'ANATOMIA', courseCode: null, startsAt: '2026-11-18T09:00:00-03:00', endsAt: null, place: 'SIGAA' });
    // 02:00Z de 20/11 é 23:00 de 19/11 em Salvador: o DIA do item é o de Salvador.
    expect(itens.find((i) => i.title === 'Entrega do relatório final')).toMatchObject({ date: '2026-11-19', kind: 'deadline', startsAt: null, endsAt: '2026-11-19T23:00:00-03:00' });
    expect(itens.every((i) => i.source === 'sigaa' || i.source === 'siasb')).toBe(true);
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'ok' }]);
  });

  it('só os do intervalo; e o prazo CONTINUA no feriado (a aula não)', async () => {
    const { svc } = build({
      calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Feriado', '2026-11-19')])],
      turmas: [SO],
      prazos: [prazo('a:avaliacao:0', 'Prova no feriado', '2026-11-19T15:00:00Z'), prazo('a:avaliacao:1', 'Prova fora', '2026-12-10T15:00:00Z')],
    });
    const r = await get(svc, '2026-11-16', '2026-11-22');
    const dia = r.days.find((d) => d.date === '2026-11-19')!;
    expect(dia.nonTeaching).toEqual({ name: 'Feriado' });
    expect(dia.items.map((i) => [i.kind, i.title])).toEqual([['exam', 'Prova no feriado']]); // sem class nesse dia
    expect(r.days.flatMap((d) => d.items).some((i) => i.title === 'Prova fora')).toBe(false);
  });

  it('prova sem hora no SIGAA vem à meia-noite (T00:00): limitação documentada', async () => {
    const { svc } = build({ turmas: [], prazos: [prazo('a:avaliacao:0', 'Prova', '2026-11-18T03:00:00Z')] }); // 00:00 em Salvador
    expect((await get(svc, '2026-11-18', '2026-11-18')).days[0].items[0].startsAt).toBe('2026-11-18T00:00:00-03:00');
  });

  it('prazos incompletos (parou no meio): as aulas ficam, os prazos lidos também, e sigaa vira failed', async () => {
    const { svc } = build({ turmas: [SO], prazos: [prazo('a:avaliacao:0', 'Prova 1', '2026-11-18T12:00:00Z')], prazosCompletos: false });
    const r = await get(svc, '2026-11-16', '2026-11-22');
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'failed' }]);
    expect(r.days.flatMap((d) => d.items).map((i) => i.kind).sort()).toEqual(['class', 'class', 'exam']);
  });

  it('leitura incompleta não vai para o cache (a próxima tenta de novo); a completa vale 12 min por pessoa, em qualquer intervalo', async () => {
    const inc = build({ turmas: [SO], prazosCompletos: false });
    await get(inc.svc, '2026-11-16', '2026-11-22');
    await get(inc.svc, '2026-11-23', '2026-11-29');
    expect(inc.calls.turmas).toBe(2);
    const ok = build({ turmas: [SO] });
    await get(ok.svc, '2026-11-16', '2026-11-22');
    await get(ok.svc, '2026-11-23', '2026-11-29');
    await get(ok.svc, '2026-12-01', '2026-12-31');
    expect(ok.calls.turmas).toBe(1);
  });

  it('o cache do SIGAA expira em 12 min', async () => {
    let agora = NOW.getTime();
    const calls = { n: 0 };
    const svc = new MeCalendar({
      calendars: { all: async () => [] },
      sigaa: { agenda: async () => ((calls.n += 1), { turmas: [], prazos: [], prazosCompletos: true }) },
      siasb: { status: async () => ({ offered: false, status: 'disconnected' }), agenda: async () => ({ stale: false, items: [] }) },
      now: () => new Date(agora),
    });
    await svc.get(Q, '2026-11-16', '2026-11-22', 'connected');
    agora += 11 * 60_000;
    await svc.get(Q, '2026-11-23', '2026-11-29', 'connected');
    expect(calls.n).toBe(1);
    agora += 2 * 60_000;
    await svc.get(Q, '2026-11-30', '2026-12-06', 'connected');
    expect(calls.n).toBe(2);
  });

  it('chamadas simultâneas da mesma pessoa viram UMA leitura do SIGAA (JSF é sequencial por sessão)', async () => {
    let liberar!: () => void;
    const { svc, calls } = build({ turmas: [SO], agendaDelay: () => new Promise<void>((r) => (liberar = r)) });
    const a = get(svc, '2026-11-16', '2026-11-22');
    const b = get(svc, '2026-11-23', '2026-11-29');
    const c = get(svc, '2026-12-01', '2026-12-31');
    await new Promise((r) => setTimeout(r, 10));
    liberar();
    await Promise.all([a, b, c]);
    expect(calls.turmas).toBe(1);
  });

  it('falha ao ler o SIGAA derruba só o sigaa (as sessões do SIASB e os feriados seguem)', async () => {
    const { svc } = build({
      calendars: [cal('2026.2', '2026-08-17', '2026-12-19', [on('Feriado', '2026-11-20')])],
      turmas: new Error('página inesperada'),
      siasb: { offered: true, status: 'connected' },
      sessions: [{ id: 's', disciplineName: 'Clínica', locationName: 'Sala 3', startAt: new Date('2026-11-18T12:00:00Z'), endAt: new Date('2026-11-18T13:00:00Z'), statusLabel: 'Confirmado' }],
    });
    const r = await get(svc, '2026-11-16', '2026-11-22');
    expect(r.sources).toEqual([{ source: 'sigaa', status: 'failed' }, { source: 'siasb', status: 'ok' }]);
    expect(r.days.flatMap((d) => d.items).map((i) => i.kind)).toEqual(['session']);
    expect(r.days.find((d) => d.date === '2026-11-20')!.nonTeaching).toEqual({ name: 'Feriado' });
  });
});

describe('classifySigaaDeadline', () => {
  it.each([
    ['Prova 2', 'exam'],
    ['1ª Unidade', 'exam'],
    ['Seminário', 'exam'],
    ['P1', 'exam'],
    ['Exame final', 'exam'],
    ['Avaliação parcial', 'exam'],
    ['Entrega do trabalho final', 'deadline'],
    ['Relatório da prática 3', 'deadline'],
    ['Lista de exercícios 4', 'deadline'],
    ['Projeto integrador', 'deadline'],
    ['Prova de projeto', 'exam'], // "prova" vence
    ['Teste do relatório', 'exam'],
  ])('%s → %s', (titulo, kind) => expect(classifySigaaDeadline(titulo)).toBe(kind));
});
