import type { CalendarDocument } from './contract';
import {
  checkChanges,
  checkCompleteness,
  checkDates,
  checkTeachingDays,
  checkNonTeachingDays,
  textDates,
  listTeachingDays,
} from './invariants';
import { readCalendar } from './read-calendar';
import type { CalendarReader } from '../ports/calendar';

/** As partes do calendário 2026.2 que têm aritmética (quadros do PDF; tudo público). */
function base(): CalendarDocument {
  return {
    document: { term: '2026.2', publishedOn: '2026-10-27' },
    keyDates: {
      termStart: '2026-08-19',
      progress25: '2026-09-17',
      progress50: '2026-10-17',
      progress75: '2026-11-18',
      termEnd: '2026-12-19',
      internship: { start: '2026-07-06', end: '2027-01-31' },
    },
    events: [
      {
        section: 'MATRÍCULA GRADUAÇÃO',
        procedure: 'Matrícula',
        responsibles: ['Estudantes Grad'],
        description: 'Matrícula WEB SIGAA- Graduação',
        when: { type: 'between', start: '2026-08-03', end: '2026-08-05' },
        additionalWindows: [],
        dateChanged: false,
        links: [],
      },
    ],
    teachingDays: {
      byMonth: [
        { month: '2026-08', days: 11 },
        { month: '2026-09', days: 25 },
        { month: '2026-10', days: 25 },
        { month: '2026-11', days: 23 },
        { month: '2026-12', days: 16 },
      ],
      total: 100,
    },
    nonTeachingDays: [
      { name: 'Independência do Brasil', when: { type: 'on', date: '2026-09-07' }, weekday: 'mon', dateChanged: false },
      { name: 'Nossa Senhora Aparecida', when: { type: 'on', date: '2026-10-12' }, weekday: 'mon', dateChanged: false },
      { name: 'Dia do Servidor Público Federal', when: { type: 'on', date: '2026-10-30' }, weekday: 'fri', dateChanged: true },
      { name: 'Finados', when: { type: 'on', date: '2026-11-02' }, weekday: 'mon', dateChanged: false },
      { name: 'Dia Nacional de Zumbi e da Consciência Negra', when: { type: 'on', date: '2026-11-20' }, weekday: 'fri', dateChanged: false },
      { name: 'Nossa Senhora da Conceição', when: { type: 'on', date: '2026-12-08' }, weekday: 'tue', dateChanged: false },
    ],
    otherEvents: [],
  };
}

describe('dias letivos', () => {
  it('o calendário 2026.2 fecha: 100 dias, meses e marcos de 25/50/75%', () => {
    expect(checkTeachingDays(base())).toEqual({ hard: [], soft: [] });
    const dias = listTeachingDays('2026-08-19', '2026-12-19', base().nonTeachingDays.flatMap((f) => (f.when.type === 'on' ? [f.when.date] : [])));
    expect(dias).toHaveLength(100);
    expect(dias[24]).toBe('2026-09-17');
    expect(dias[49]).toBe('2026-10-17');
    expect(dias[74]).toBe('2026-11-18');
  });

  it('um mês com valor trocado é apontado', () => {
    const c = base();
    c.teachingDays.byMonth[1] = { month: '2026-09', days: 26 };
    const failures = checkTeachingDays(c).hard;
    expect(failures.join(' ')).toMatch(/soma dos meses/);
    expect(failures.join(' ')).toMatch(/2026-09/);
  });

  it('lista de não letivos incompleta num documento coerente: aviso, não falha (caso do 2025.1)', () => {
    const c = base();
    c.nonTeachingDays = c.nonTeachingDays.filter((f) => f.name !== 'Finados');
    const r = checkTeachingDays(c);
    expect(r.hard).toEqual([]);
    expect(r.soft.join(' ')).toMatch(/2026-11: a conta dá 24, o documento declara 23/);
  });

  it('um marco com data errada é apontado', () => {
    const c = base();
    c.keyDates.progress50 = '2026-10-16';
    expect(checkTeachingDays(c).hard.join(' ')).toMatch(/Marco 50%/);
  });
});

describe('holidays e datas', () => {
  it('dia da semana errado é apontado', () => {
    const c = base();
    c.nonTeachingDays[0] = { ...c.nonTeachingDays[0]!, weekday: 'tue' };
    expect(checkNonTeachingDays(c).join(' ')).toMatch(/Independência/);
  });

  it('data inexistente, intervalo invertido e ano absurdo viram failures', () => {
    const c = base();
    c.events[0]!.when = { type: 'between', start: '2026-08-05', end: '2026-08-03' };
    c.nonTeachingDays[1] = { ...c.nonTeachingDays[1]!, when: { type: 'on' as const, date: '2026-02-30' } };
    c.otherEvents.push({ name: 'X', when: { type: 'on', date: '2126-01-01' }, links: [] });
    const failures = checkDates(c).join(' ');
    expect(failures).toMatch(/início \(2026-08-05\) depois do to/);
    expect(checkNonTeachingDays(c).join(' ')).toMatch(/inválida: "2026-02-30"/);
    expect(failures).toMatch(/fora do plausível/);
  });

  it('o calendário de exemplo não tem falha de datas', () => {
    expect(checkDates(base())).toEqual([]);
    expect(checkNonTeachingDays(base())).toEqual([]);
  });
});

describe('completude e alterações', () => {
  const texto = 'Matrícula WEB 03/08 a 05/08/2026\nFinados 02/11/2026 (seg)\nPublicação 27/10/2026';

  it('lê datas com e sem ano', () => {
    expect([...textDates(texto)].sort()).toEqual(['02/11', '03/08', '05/08', '27/10']);
  });

  it('data impressa que sumiu da saída é apontada', () => {
    const c = base();
    c.nonTeachingDays = c.nonTeachingDays.filter((f) => f.name !== 'Finados');
    expect(checkCompleteness(c, texto).join(' ')).toMatch(/02\/11/);
  });

  it('com tudo presente não há falha', () => {
    const c = base();
    expect(checkCompleteness(c, 'Matrícula 03/08 a 05/08/2026 e Aparecida 12/10/2026')).toEqual([]);
  });

  it('asterisco no texto exige dateChanged, e o contrário também', () => {
    const c = base();
    expect(checkChanges(c, 'Servidor 30/10/2026 (sex)*')).toEqual([]);
    c.nonTeachingDays[2] = { ...c.nonTeachingDays[2]!, dateChanged: false };
    expect(checkChanges(c, 'Servidor 30/10/2026 (sex)*').join(' ')).toMatch(/nenhuma saiu/);
    expect(checkChanges(base(), 'sem marcas 30/10/2026 (sex)').join(' ')).toMatch(/não tem \*/);
  });
});

describe('readCalendar', () => {
  const leitorFixo = (doc: CalendarDocument): CalendarReader => ({ read: async () => ({ document: doc }) });
  const texto = 'Matrícula 03/08 a 05/08/2026\nPublicação 27/10/2026 Servidor 30/10/2026 (sex)*';

  it('contrato coerente sai verificado, com a versão e o leitor', async () => {
    const c = await readCalendar(texto, leitorFixo(base()));
    expect(c.contractVersion).toBe('1');
    expect(c.verification.reader).toBe('ai');
    expect(c.verification.warnings.filter((w) => !/ausentes da saída/.test(w))).toEqual([]);
  });

  it('leitura errada é entregue, mas não verificada e com o motivo', async () => {
    const doc = base();
    doc.teachingDays.total = 99;
    const c = await readCalendar(texto, leitorFixo(doc));
    expect(c.verification.verified).toBe(false);
    expect(c.events).toHaveLength(1);
    expect(c.verification.warnings.join(' ')).toMatch(/Dias letivos/);
  });

  it('se o modelo falha, o erro sobe', async () => {
    const leitor: CalendarReader = {
      read: async () => {
        throw new Error('sem crédito');
      },
    };
    await expect(readCalendar(texto, leitor)).rejects.toThrow('sem crédito');
  });
});

describe('dias não letivos em intervalo e campos opcionais', () => {
  it('um recesso em intervalo sai da conta dos dias letivos (caso do 2025.2)', () => {
    const c = base();
    c.keyDates.termEnd = '2026-12-19';
    c.teachingDays.byMonth[4] = { month: '2026-12', days: 16 };
    // Sem recesso o mês fecha em 16; com um recesso de 14 a 19/12 (seg–sáb = 6 dias) cai para 10.
    c.nonTeachingDays.push({
      name: 'Recesso',
      when: { type: 'between', start: '2026-12-14', end: '2026-12-19' },
      weekday: null,
      dateChanged: false,
    });
    expect(checkTeachingDays(c).soft.join(' ')).toMatch(/2026-12: a conta dá 10/);
  });

  it('publishedOn e internship ausentes não são falha', () => {
    const c = base();
    c.document.publishedOn = null;
    c.keyDates.internship = null;
    expect(checkDates(c)).toEqual([]);
  });

  it('a faixa plausível acompanha o semestre: 2024 vale para 2025.1, não para 2026.2', () => {
    const c = base();
    c.otherEvents.push({ name: 'X', when: { type: 'on', date: '2024-11-18' }, links: [] });
    expect(checkDates(c).join(' ')).toMatch(/fora do plausível para o semestre 2026.2/);
    c.document.term = '2025.1';
    c.keyDates.termStart = '2025-03-01';
    expect(checkDates(c).join(' ')).not.toMatch(/2024-11-18/);
  });
});

describe('datas de rodapé e dias soltos', () => {
  it('ignora datas de rodapé (aprovação do CONSEPE, versão), mantendo a data do evento da mesma linha', () => {
    const t = '23 e 24/06 - São João 100 (*) Datas aprovadas pelo CONSEPE em 11/10/2023\nConsulte o REGPG - Versão: 20/03/2023';
    expect([...textDates(t)].sort()).toEqual(['23/06', '24/06']);
  });

  it('lê listas e intervalos que dividem o mês com a última data', () => {
    expect([...textDates('Inscrição 13, 14, 17 e 18/03/2025')].sort()).toEqual(['13/03', '14/03', '17/03', '18/03']);
    expect([...textDates('09 a 11/08/2023')].sort()).toEqual(['09/08', '11/08']);
    // data com mês próprio não vira lista: "13/08 a 15/08/2026"
    expect([...textDates('13/08 a 15/08/2026')].sort()).toEqual(['13/08', '15/08']);
  });

  it('dias soltos de um evento (janelas de um dia) entram nas datas da saída', () => {
    const c = base();
    const dia = (d: string) => ({ start: d, end: d });
    c.events[0]!.when = { type: 'on', date: '2025-03-13' };
    c.events[0]!.additionalWindows = [dia('2025-03-14'), dia('2025-03-17'), dia('2025-03-18')];
    expect(checkCompleteness(c, 'Inscrição 13, 14, 17 e 18/03/2025')).toEqual([]);
    c.events[0]!.additionalWindows = [dia('2025-03-18')];
    expect(checkCompleteness(c, 'Inscrição 13, 14, 17 e 18/03/2025').join(' ')).toMatch(/14\/03, 17\/03/);
  });
});

describe('verified com dia não letivo não listado', () => {
  const texto = 'Matrícula 03/08 a 05/08/2026 Publicação 27/10/2026';
  const leitorFixo = (doc: CalendarDocument): CalendarReader => ({ read: async () => ({ document: doc }) });

  it('documento coerente com lista incompleta: continua verified, com o aviso', async () => {
    const doc = base();
    doc.nonTeachingDays = doc.nonTeachingDays.filter((f) => f.name !== 'Finados');
    const c = await readCalendar(texto, leitorFixo(doc));
    expect(c.verification.warnings.join(' ')).toMatch(/2026-11/);
    expect(c.verification.warnings.join(' ')).toMatch(/pode haver dia não letivo que o documento não lista/);
    // as hard restantes são só de completude do texto de teste, não de dias letivos
    expect(c.verification.warnings.filter((w) => /soma dos meses|Marco/.test(w))).toEqual([]);
  });

  it('documento que se contradiz (meses não somam o total): falha dura', async () => {
    const doc = base();
    doc.teachingDays.byMonth[0] = { month: '2026-08', days: 12 };
    const c = await readCalendar(texto, leitorFixo(doc));
    expect(c.verification.verified).toBe(false);
    expect(c.verification.warnings.join(' ')).toMatch(/soma dos meses/);
  });
});
