import { AadCipher, FakePushSender, InMemoryAlertLog, InMemoryNotificationSettings, InMemoryPushDevices } from '../../../test/support/notifications-fake';
import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import { alertChain, chainSlotAtOrBefore } from '../../domain/siasb/alert-schedule';
import { AcademicCalendar } from '../ports/academic-calendar';
import { SourceAccountRepository, type SourceAccountRecord } from '../ports/repositories';
import type { SyncedAttendance, SyncedSession } from '../ports/siasb-copy';
import { NotificationSettings } from '../notifications/notification-settings.service';
import { Notifier } from '../notifications/notifier';
import { PushDevices } from '../notifications/push-devices.service';
import { SiasbCopyReader } from './siasb-copy-reader';
import { SiasbAlerts, reconnectSlots } from './siasb-alerts';
import type { DisciplineSituation } from './situation';

const U = 'u1';
const FCM = (n: number) => `https://fcm.googleapis.com/fcm/send/dispositivo-${n}`;
const sub = (n: number) => ({ endpoint: FCM(n), keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });
const at = (s: string) => new Date(s);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Prazo: sexta, 20/11/2026, 10h (Bahia). Cadeia: ... 16/11 19h, 18/11 07h, 19/11 19h (último, 6 h acordado antes do prazo).
const D = at('2026-11-20T10:00:00-03:00');
const SLOT_LAST = at('2026-11-19T19:00:00-03:00');
const SLOT_PREV = at('2026-11-18T07:00:00-03:00');
const SLOT_PREV2 = at('2026-11-16T19:00:00-03:00');
const SLOT_F = at('2026-11-20T14:00:00-03:00'); // horário da clínica (nextSlot do item): é o episódio
const SUBJECT = `disc:d1:${SLOT_F.toISOString()}`;

const item = (over: Partial<DisciplineSituation> = {}): DisciplineSituation => ({
  disciplineId: 'd1',
  disciplineName: 'Clínica Integrada I',
  state: 'NO_SESSION',
  nextSlot: at('2026-11-20T14:00:00-03:00'),
  deadline: D,
  estimated: true,
  holidaysConsidered: true,
  ...over,
});

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [];
  reads = 0;
  async upsert(): Promise<SourceAccountRecord> {
    throw new Error('não usado');
  }
  async findByUserAndProvider(userId: string, provider: string) {
    this.reads++;
    return this.rows.filter((r) => r.userId === userId && r.provider === provider);
  }
  async listByUser() {
    return [];
  }
  async setStatus() {}
  async updateSecret() {}
  async delete() {}
}

const account = (expiresAt: Date | null): SourceAccountRecord => ({
  id: 'acc1',
  userId: U,
  provider: 'SIASB',
  accountKey: 'k',
  siteUrl: null,
  status: 'OK',
  lastSyncedAt: null,
  expiresAt,
  secret: null,
});

async function setup() {
  const clock = { now: at('2026-11-18T12:00:00-03:00') };
  const sender = new FakePushSender();
  const repo = new InMemoryPushDevices();
  const settings = new InMemoryNotificationSettings();
  const log = new InMemoryAlertLog();
  const now = () => clock.now;
  const devices = new PushDevices(repo, sender, new AadCipher(), now);
  const notifier = new Notifier(sender, new NotificationSettings(settings, now), devices, log, now);
  const copy = new InMemorySiasbCopy();
  copy.accounts.set(U, 'OK');
  copy.seedState(U);
  const accounts = new FakeAccounts();
  const t = {
    clock,
    sender,
    settings,
    log,
    devices,
    notifier,
    copy,
    accounts,
    items: [item()] as DisciplineSituation[],
    previous: {} as Record<string, { slot: Date; deadline: Date; covered: boolean } | null>,
    situationCalls: 0,
    syncOk: true,
    reader: null as unknown as SiasbCopyReader,
    alerts: null as unknown as SiasbAlerts,
    /** Avalia em `when`: a cópia teve sucesso um minuto antes (a menos que o teste a tenha deixado velha). */
    async run(when: string) {
      clock.now = at(when);
      if (t.syncOk) await copy.recordAttempt(U, { result: 'OK', at: new Date(clock.now.getTime() - 60_000), nextRunAt: null });
      return t.alerts.evaluateUser(U, clock.now);
    },
    bodies: () => sender.sent.map((s) => JSON.parse(s.payload).body as string),
    keys: () => [...log.rows.keys()].map((k) => k.split('|').slice(1).join('|')),
  };
  t.reader = {
    situation: async (userId: string) => {
      t.situationCalls++;
      const st = await copy.state(userId);
      return { syncedAt: st?.lastSuccessAt ?? null, stale: false, items: t.items, previous: t.previous };
    },
  } as unknown as SiasbCopyReader;
  t.alerts = new SiasbAlerts(t.reader, copy, notifier, accounts);
  await devices.register(U, { subscription: sub(1) });
  return t;
}

describe('reconnectSlots', () => {
  const E = at('2026-11-30T12:00:00-03:00');
  it('7, 3 e 1 dia antes do vencimento, o vencimento e depois a cada 36 h desde ele', () => {
    const all = reconnectSlots(E, at('2026-01-01T00:00:00Z'), at('2026-12-04T00:00:00-03:00'));
    expect(all.map((d) => d.toISOString())).toEqual([
      at('2026-11-23T12:00:00-03:00').toISOString(),
      at('2026-11-27T12:00:00-03:00').toISOString(),
      at('2026-11-29T12:00:00-03:00').toISOString(),
      E.toISOString(),
      new Date(E.getTime() + 36 * HOUR).toISOString(),
      new Date(E.getTime() + 72 * HOUR).toISOString(),
    ]);
  });

  it('só > after (exclusivo) e <= upTo (inclusivo); o que cai no silêncio NÃO é movido', () => {
    expect(reconnectSlots(E, at('2026-11-27T12:00:00-03:00'), at('2026-11-29T12:00:00-03:00')).map((d) => d.toISOString())).toEqual([at('2026-11-29T12:00:00-03:00').toISOString()]);
    // vencimento + 36 h = 02/12 00:00 (silêncio): continua sendo esse instante
    expect(reconnectSlots(E, at('2026-11-30T12:00:00-03:00'), at('2026-12-02T03:00:00-03:00'))[0].toISOString()).toBe(at('2026-12-02T00:00:00-03:00').toISOString());
  });

  it('vencido há muito tempo: não percorre desde o vencimento (só os instantes depois de `after`)', () => {
    const far = new Date(E.getTime() + 3000 * DAY);
    const slots = reconnectSlots(E, new Date(far.getTime() - 100 * HOUR), far);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.length).toBeLessThanOrEqual(3);
  });
});

describe('SiasbAlerts: aviso de prazo', () => {
  it('primeiro aviso na detecção: slotAt = instante da cadeia anterior ou igual a agora; textos do ②', async () => {
    const t = await setup();
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 1, suppressed: 0, skipped: 0, failed: 0 });
    expect(chainSlotAtOrBefore(D, t.clock.now)).toEqual(SLOT_PREV);
    expect(t.keys()).toEqual([`siasb.alerts|${SUBJECT}|${SLOT_PREV.toISOString()}`]);
    const payload = JSON.parse(t.sender.sent[0].payload);
    expect(payload).toEqual({
      title: 'SIASB',
      body: 'Você tem paciente em Clínica Integrada I, mas a clínica de sexta ainda está sem sessão. Prazo estimado: sexta, 20/11, às 10h.',
      tag: 'siasb-disc:d1',
      url: '/',
    });
  });

  it('cadeia ainda não começou: slotAt = agora truncado à hora (o instante futuro da cadeia continua livre)', async () => {
    const t = await setup();
    await t.run('2026-09-01T12:00:00-03:00');
    expect(t.keys()).toEqual([`siasb.alerts|${SUBJECT}|${at('2026-09-01T12:00:00-03:00').toISOString()}`]);
    expect(t.sender.sent).toHaveLength(1);
    expect((await t.run('2026-11-19T19:30:00-03:00')).sent).toBe(1);
    expect(t.keys()).toContain(`siasb.alerts|${SUBJECT}|${SLOT_LAST.toISOString()}`);
  });

  it('① com prazo tem o seu texto', async () => {
    const t = await setup();
    t.items = [item({ state: 'NO_PATIENT' })];
    await t.run('2026-11-18T12:00:00-03:00');
    expect(t.bodies()).toEqual([
      'Você ainda não tem paciente em Clínica Integrada I, e a clínica de sexta está sem sessão. Cadastre ou pegue um paciente e marque até sexta, 20/11, às 10h (prazo estimado).',
    ]);
  });

  it('avisos seguintes nos instantes da cadeia, cada um uma só vez (duas rodadas no mesmo instante enviam uma)', async () => {
    const t = await setup();
    await t.run('2026-11-18T12:00:00-03:00'); // primeiro
    expect((await t.run('2026-11-18T12:00:00-03:00')).sent).toBe(0); // nada devido
    expect((await t.run('2026-11-19T18:59:00-03:00')).sent).toBe(0); // antes do instante
    expect((await t.run('2026-11-19T19:05:00-03:00')).sent).toBe(1);
    expect((await t.run('2026-11-19T19:05:00-03:00')).sent).toBe(0);
    expect((await t.run('2026-11-19T21:00:00-03:00')).sent).toBe(0);
    expect(t.sender.sent).toHaveLength(2);
    expect(t.keys()).toContain(`siasb.alerts|${SUBJECT}|${SLOT_LAST.toISOString()}`);
  });

  it('rajada: vários instantes devidos enviam só o mais recente e gravam os anteriores como suppressed', async () => {
    const t = await setup();
    await t.run('2026-11-16T12:00:00-03:00'); // primeiro (queda depois disso)
    expect(alertChain(D, t.clock.now, at('2026-11-19T20:00:00-03:00'))).toEqual([SLOT_PREV2, SLOT_PREV, SLOT_LAST]);
    const r = await t.run('2026-11-19T20:00:00-03:00');
    expect(r).toEqual({ sent: 1, suppressed: 2, skipped: 0, failed: 0 });
    expect(t.sender.sent).toHaveLength(2);
    const rows = [...t.log.rows.entries()];
    const suppressed = rows.filter(([, v]) => v.suppressed).map(([k]) => k.split('|')[3]);
    expect(suppressed.sort()).toEqual([SLOT_PREV2.toISOString(), SLOT_PREV.toISOString()].sort());
    expect(rows.find(([k]) => k.endsWith(SLOT_LAST.toISOString()))![1].suppressed).toBe(false);
    // as anotações suppressed não contam como envio: a próxima rodada não repete nada
    expect((await t.run('2026-11-19T20:05:00-03:00')).sent).toBe(0);
  });

  it('duas avaliações concorrentes da mesma pessoa enviam UM aviso (primeiro e seguinte)', async () => {
    const t = await setup();
    clockSet(t, '2026-11-18T12:00:00-03:00');
    await t.copy.recordAttempt(U, { result: 'OK', at: t.clock.now, nextRunAt: null });
    const first = await Promise.all([t.alerts.evaluateUser(U, t.clock.now), t.alerts.evaluateUser(U, t.clock.now)]);
    expect(t.sender.sent).toHaveLength(1);
    expect(first.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(first.reduce((n, r) => n + r.skipped, 0)).toBe(1);

    clockSet(t, '2026-11-19T19:30:00-03:00');
    await t.copy.recordAttempt(U, { result: 'OK', at: t.clock.now, nextRunAt: null });
    const next = await Promise.all([t.alerts.evaluateUser(U, t.clock.now), t.alerts.evaluateUser(U, t.clock.now)]);
    expect(t.sender.sent).toHaveLength(2);
    expect(next.reduce((n, r) => n + r.sent, 0)).toBe(1);
  });

  it('silêncio 22h-7h: não envia e não registra; na próxima rodada acordada envia (primeiro aviso)', async () => {
    const t = await setup();
    const r = await t.run('2026-11-18T23:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
    expect(t.log.rows.size).toBe(0);
    expect((await t.run('2026-11-19T07:00:00-03:00')).sent).toBe(1);
    expect(t.keys()).toEqual([`siasb.alerts|${SUBJECT}|${SLOT_PREV.toISOString()}`]);
  });

  it('silêncio no meio de uma rajada: nada gravado (nem suppressed); depois do silêncio envia e grava', async () => {
    const t = await setup();
    await t.run('2026-11-16T12:00:00-03:00');
    const before = t.log.rows.size;
    const r = await t.run('2026-11-19T23:00:00-03:00');
    expect(r.sent + r.suppressed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(t.log.rows.size).toBe(before);
    const after = await t.run('2026-11-20T07:30:00-03:00');
    expect(after).toEqual({ sent: 1, suppressed: 2, skipped: 0, failed: 0 });
  });

  it('a disciplina vira SCHEDULED entre dois avisos: nada mais sai', async () => {
    const t = await setup();
    await t.run('2026-11-18T12:00:00-03:00');
    t.items = [item({ state: 'SCHEDULED' })];
    const r = await t.run('2026-11-19T19:30:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 0, failed: 0 });
    expect(t.sender.sent).toHaveLength(1);
  });

  it('disciplina em SCHEDULED desde o início: nenhum aviso', async () => {
    const t = await setup();
    t.items = [item({ state: 'SCHEDULED' })];
    await t.run('2026-11-18T12:00:00-03:00');
    expect(t.sender.sent).toHaveLength(0);
    expect(t.log.rows.size).toBe(0);
  });

  it('cada disciplina tem o seu aviso, com subject próprio', async () => {
    const t = await setup();
    t.items = [item(), item({ disciplineId: 'd2', disciplineName: 'Clínica Integrada II', state: 'NO_PATIENT' })];
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r.sent).toBe(2);
    expect(t.keys().map((k) => k.split('|')[1]).sort()).toEqual([SUBJECT, `disc:d2:${SLOT_F.toISOString()}`]);
  });
});

describe('SiasbAlerts: silêncio 22h-7h (decidido aqui)', () => {
  it.each(['2026-11-18T22:00:00-03:00', '2026-11-19T03:00:00-03:00', '2026-11-19T06:59:00-03:00'])(
    'em %s: nada enviado nem registrado, skipped, sem ler a cópia',
    async (when) => {
      const t = await setup();
      t.accounts.rows = [account(at('2026-11-19T12:00:00-03:00'))];
      const r = await t.run(when);
      expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
      expect(t.sender.sent).toHaveLength(0);
      expect(t.log.rows.size).toBe(0);
      expect(t.situationCalls).toBe(0);
    },
  );

  it('às 07:00 em ponto o aviso devido sai; 22:00 seguido de 07:00 envia exatamente uma vez', async () => {
    const t = await setup();
    await t.run('2026-11-18T22:00:00-03:00');
    expect((await t.run('2026-11-19T07:00:00-03:00')).sent).toBe(1);
    expect((await t.run('2026-11-19T07:15:00-03:00')).sent).toBe(0);
    expect(t.sender.sent).toHaveLength(1);
  });

  it('reconexão: nada no silêncio; sai uma vez às 07:00 (instante 02/12 00:00 não é movido)', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [account(at('2026-11-30T12:00:00-03:00'))];
    await t.run('2026-11-30T12:05:00-03:00');
    const before = t.log.rows.size;
    expect((await t.run('2026-12-02T00:00:00-03:00')).sent).toBe(0);
    expect(t.log.rows.size).toBe(before);
    expect((await t.run('2026-12-02T07:00:00-03:00')).sent).toBe(1);
    expect(t.keys().pop()).toBe(`siasb.alerts|connection|${at('2026-12-02T00:00:00-03:00').toISOString()}`);
  });

  it('rajada depois de silêncio longo: nada às 22h/03h; às 07:00 envia só o mais recente e grava os anteriores suppressed', async () => {
    const t = await setup();
    await t.run('2026-11-16T12:00:00-03:00');
    const before = t.log.rows.size;
    for (const when of ['2026-11-19T22:00:00-03:00', '2026-11-20T03:00:00-03:00']) {
      expect(await t.run(when)).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
      expect(t.log.rows.size).toBe(before);
    }
    expect(await t.run('2026-11-20T07:00:00-03:00')).toEqual({ sent: 1, suppressed: 2, skipped: 0, failed: 0 });
  });
});

describe('SiasbAlerts: prazo perdido (a partir do horário anterior da leitura)', () => {
  const PREV = (over: Partial<{ slot: Date; deadline: Date; covered: boolean }> = {}) => ({
    d1: { slot: at('2026-11-20T14:00:00-03:00'), deadline: D, covered: false, ...over },
  });
  /** Avisou do prazo de 20/11 e agora a leitura já mostra o horário seguinte (prazo deslocado: quinta 26/11, 10h). */
  async function missedSetup() {
    const t = await setup();
    await t.run('2026-11-19T19:30:00-03:00');
    t.items = [item({ nextSlot: at('2026-11-26T14:00:00-03:00'), deadline: at('2026-11-26T10:00:00-03:00') })];
    t.previous = PREV();
    return t;
  }
  const perdido = (t: { bodies: () => string[] }) => t.bodies().filter((b) => b.startsWith('Prazo perdido'));

  it('avisou, não marcou e o prazo passou: um "Prazo perdido" com a próxima chance (mesmo com prazo deslocado), uma só vez', async () => {
    const t = await missedSetup();
    const r = await t.run('2026-11-20T11:00:00-03:00');
    expect(r.sent).toBe(1); // só o perdido: ele já anuncia a próxima chance (o primeiro aviso do episódio novo é só anotado)
    const novo = `disc:d1:${at('2026-11-26T14:00:00-03:00').toISOString()}`;
    expect(t.keys().some((k) => k.startsWith(`siasb.alerts|${novo}|`))).toBe(true);
    expect(perdido(t)).toEqual(['Prazo perdido em Clínica Integrada I. Próxima chance: quinta, 26/11, às 10h.']);
    expect(t.keys()).toContain(`siasb.alerts|${SUBJECT}|${D.toISOString()}`);
    expect((await t.run('2026-11-20T11:15:00-03:00')).sent).toBe(0);
    expect(perdido(t)).toHaveLength(1);
  });

  it('marcou e atendeu (voltou a NO_SESSION): sessão no dia do horário -> sem "perdido"', async () => {
    const t = await missedSetup();
    t.previous = PREV({ covered: true });
    await t.run('2026-11-20T15:00:00-03:00');
    expect(perdido(t)).toEqual([]);
  });

  it('prazo perdido há mais de 72 h: não avisa (nunca um "perdido" velho depois de uma queda)', async () => {
    const t = await missedSetup();
    await t.run('2026-11-23T11:00:00-03:00'); // 73 h depois do prazo
    expect(perdido(t)).toEqual([]);
    const ok = await missedSetup();
    await ok.run('2026-11-23T10:00:00-03:00'); // exatamente 72 h
    expect(perdido(ok)).toHaveLength(1);
  });

  it('não foi avisada naquele episódio (lastSentAt nulo): não avisa de perdido', async () => {
    const t = await setup();
    t.items = [item({ nextSlot: at('2026-11-26T14:00:00-03:00'), deadline: at('2026-11-26T10:00:00-03:00') })];
    t.previous = PREV();
    const r = await t.run('2026-11-20T11:00:00-03:00');
    expect(r.sent).toBe(1);
    expect(perdido(t)).toEqual([]);
  });

  it('disciplina em SCHEDULED: nada, nem perdido', async () => {
    const t = await missedSetup();
    t.items = [item({ state: 'SCHEDULED' })];
    await t.run('2026-11-20T11:00:00-03:00');
    expect(t.sender.sent).toHaveLength(1);
  });

  it('sem próximo horário: o texto vem sem a segunda frase', async () => {
    const t = await missedSetup();
    t.items = [item({ nextSlot: null, deadline: null })];
    await t.run('2026-11-20T11:00:00-03:00');
    expect(perdido(t)).toEqual(['Prazo perdido em Clínica Integrada I.']);
  });

  it('não é palpite de uma semana antes: prazo anterior qualquer (não 7 dias antes) também avisa', async () => {
    const t = await missedSetup();
    t.items = [item({ nextSlot: at('2026-12-03T14:00:00-03:00'), deadline: at('2026-12-03T10:00:00-03:00') })];
    await t.run('2026-11-20T11:00:00-03:00');
    expect(perdido(t)).toEqual(['Prazo perdido em Clínica Integrada I. Próxima chance: quinta, 03/12, às 10h.']);
  });
});

describe('SiasbAlerts: prazo perdido de ponta a ponta (leitor real da cópia)', () => {
  const HOURMS = 3_600_000;
  /** Sextas 14h da Bahia (30/10, 06/11, 13/11 atendidas); o horário de 20/11 tem prazo na terça 17/11 14h. */
  async function real(extra: { id: string; start: string; label: string; resched?: string }[], known: boolean | AcademicCalendar = false) {
    const t = await setup();
    const cipher = new AadCipher();
    class Cal extends AcademicCalendar {
      async holidays() {
        return { known: known as boolean, dates: [] as string[] };
      }
    }
    const calendar = typeof known === "boolean" ? new Cal() : known;
    const att: SyncedAttendance = {
      id: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clínica Integrada I',
      treatmentType: 'PLANNING',
      concluded: false,
      active: true,
      firstName: cipher.encrypt('Zeferina', `siasb-attendance:${U}:a1`),
    };
    const ses = (id: string, start: string, label: string, resched?: string): SyncedSession => ({
      id,
      attendanceId: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clínica Integrada I',
      professorName: 'Profa. Teste',
      locationName: 'Sala 1',
      startAt: at(start),
      endAt: new Date(at(start).getTime() + HOURMS),
      rescheduledStartAt: resched ? at(resched) : null,
      statusLabel: label,
    });
    const weekly = [ses('s1', '2026-10-30T14:00:00-03:00', 'Atendido'), ses('s2', '2026-11-06T14:00:00-03:00', 'Atendido'), ses('s3', '2026-11-13T14:00:00-03:00', 'Atendido')];
    const load = (more: typeof extra) =>
      t.copy.replaceWindow(
        U,
        { from: at('2026-09-01T00:00:00Z'), to: at('2026-12-31T00:00:00Z') },
        { disciplines: [{ id: 'd1', name: 'Clínica Integrada I' }], attendances: [att], sessions: [...weekly, ...more.map((m) => ses(m.id, m.start, m.label, m.resched))] },
      );
    await load([]);
    const alerts = new SiasbAlerts(new SiasbCopyReader(t.copy, cipher, calendar, () => t.clock.now), t.copy, t.notifier, t.accounts);
    const run = async (when: string) => {
      t.clock.now = at(when);
      await t.copy.recordAttempt(U, { result: 'OK', at: new Date(t.clock.now.getTime() - 60_000), nextRunAt: null });
      return alerts.evaluateUser(U, t.clock.now);
    };
    const warned = await run('2026-11-17T12:00:00-03:00'); // avisa do prazo de terça 14h
    expect(warned.sent).toBe(1);
    await load(extra);
    return { t, run };
  }
  const perdido = (t: { bodies: () => string[] }) => t.bodies().filter((b) => b.startsWith('Prazo perdido'));

  it('avisou e não marcou nada: "Prazo perdido" (uma vez) com a próxima chance', async () => {
    const { t, run } = await real([]);
    await run('2026-11-19T20:00:00-03:00');
    expect(perdido(t)).toHaveLength(1);
    expect(perdido(t)[0]).toMatch(/^Prazo perdido em Clínica Integrada I\. Próxima chance: terça, 24\/11, às 14h\.$/);
    await run('2026-11-19T20:15:00-03:00');
    expect(perdido(t)).toHaveLength(1);
  });

  it('reposição na quinta 19/11 (outro dia que o horário de sexta), já atendida: NÃO é perdido', async () => {
    const { t, run } = await real([{ id: 'm1', start: '2026-11-19T14:00:00-03:00', label: 'Atendido' }]);
    await run('2026-11-19T20:00:00-03:00');
    expect(perdido(t)).toEqual([]);
  });

  it('Falta paciente no dia do horário cobre (com controle: sem essa sessão o "perdido" SAI, na mesma janela de 72 h)', async () => {
    // calendário conhecido: prazo na quarta 18/11 14h; a rodada de 20/11 20h tem 54 h de idade (dentro das 72 h)
    const withSession = await real([{ id: 'm1', start: '2026-11-20T14:00:00-03:00', label: 'Falta paciente' }], true);
    await withSession.run('2026-11-20T20:00:00-03:00');
    expect(perdido(withSession.t)).toEqual([]);
    const control = await real([], true);
    await control.run('2026-11-20T20:00:00-03:00');
    expect(perdido(control.t)).toHaveLength(1);
  });

  it('sessão remarcada (rescheduledStartAt) para dentro do intervalo cobre (com controle sem ela)', async () => {
    const moved = await real([{ id: 'm2', start: '2026-11-10T14:00:00-03:00', label: 'Atendido', resched: '2026-11-19T10:00:00-03:00' }]);
    await moved.run('2026-11-19T20:00:00-03:00');
    expect(perdido(moved.t)).toEqual([]);
    const control = await real([]);
    await control.run('2026-11-19T20:00:00-03:00');
    expect(perdido(control.t)).toHaveLength(1);
  });

  it('o estado da cópia é lido uma vez por avaliação (o leitor recebe o estado já lido)', async () => {
    const { t, run } = await real([]);
    const spy = jest.spyOn(t.copy, 'state');
    await run('2026-11-19T20:00:00-03:00');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('calendário com known diferente por janela (vão de um dia útil)', () => {
    /** known só na janela [agora, agora + 45 d] (a dos itens); a do anterior (agora − 14 d) não é coberta. */
    class ByInterval extends AcademicCalendar {
      async holidays(from: Date, to: Date) {
        return { known: to.getTime() - from.getTime() <= 45 * DAY, dates: [] as string[] };
      }
    }
    // horário sexta 20/11 14h: prazo conhecido = quarta 18/11 14h; com margem de 1 dia útil = terça 17/11 14h (o vão).
    it('dentro do vão [terça 14h, quarta 14h): avisou e não marcou, mas NÃO há "Prazo perdido" (prazo ainda aberto)', async () => {
      const { t, run } = await real([], new ByInterval());
      await run('2026-11-17T20:00:00-03:00');
      await run('2026-11-18T13:45:00-03:00');
      expect(perdido(t)).toEqual([]);
    });

    it('depois do prazo conhecido (quarta 14h): o "perdido" do horário sai uma vez (caso normal intacto)', async () => {
      const { t, run } = await real([], new ByInterval());
      await run('2026-11-17T20:00:00-03:00');
      await run('2026-11-18T20:00:00-03:00');
      expect(perdido(t)).toHaveLength(1);
      expect(perdido(t)[0]).toMatch(/^Prazo perdido em Clínica Integrada I. Próxima chance: /);
      await run('2026-11-18T20:15:00-03:00');
      expect(perdido(t)).toHaveLength(1);
    });
  });

  it('sessão cancelada no intervalo não cobre: é perdido', async () => {
    const { t, run } = await real([{ id: 'm1', start: '2026-11-19T14:00:00-03:00', label: 'Cancelada' }]);
    await run('2026-11-19T20:00:00-03:00');
    expect(perdido(t)).toHaveLength(1);
  });
});

describe('SiasbAlerts: sem horário conhecido', () => {
  const none = () => [item({ state: 'NO_PATIENT', nextSlot: null, deadline: null })];

  it('primeiro aviso na hora, slotAt = agora truncado à hora, sem citar prazo', async () => {
    const t = await setup();
    t.items = none();
    await t.run('2026-11-18T12:34:00-03:00');
    expect(t.bodies()).toEqual(['Você ainda não tem paciente nem sessão marcada em Clínica Integrada I. Confira os horários no SIASB.']);
    expect(t.keys()).toEqual([`siasb.alerts|disc:d1:unscheduled|${at('2026-11-18T12:00:00-03:00').toISOString()}`]);
    expect(JSON.parse(t.sender.sent[0].payload).tag).toBe('siasb-disc:d1');
  });

  it('depois, a cada 36 h (o que cair no silêncio vale as 7h seguintes), cada instante uma vez', async () => {
    const t = await setup();
    t.items = none();
    await t.run('2026-11-18T12:34:00-03:00');
    expect((await t.run('2026-11-18T12:50:00-03:00')).sent).toBe(0);
    // 12:34 + 36 h = 20/11 00:34 (silêncio): vale as 07:00
    expect((await t.run('2026-11-20T03:00:00-03:00')).sent).toBe(0);
    expect((await t.run('2026-11-20T08:00:00-03:00')).sent).toBe(1);
    expect(t.keys()).toContain(`siasb.alerts|disc:d1:unscheduled|${at('2026-11-20T07:00:00-03:00').toISOString()}`);
    expect((await t.run('2026-11-20T09:00:00-03:00')).sent).toBe(0);
  });
});

describe('SiasbAlerts: a cópia só vale se recente e confiável', () => {
  it('após a migração (nunca sincronizada, lastSuccessAt nulo): nenhum aviso de prazo, skipped contado', async () => {
    const t = await setup();
    t.syncOk = false; // linhas antigas: tudo apareceria como NO_PATIENT
    t.items = [item({ state: 'NO_PATIENT', nextSlot: null, deadline: null })];
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
    expect(t.sender.sent).toHaveLength(0);
    expect(t.log.rows.size).toBe(0);
  });

  it('sem linha de estado: o mesmo', async () => {
    const t = await setup();
    await t.copy.deleteAll(U);
    t.syncOk = false;
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
    expect(t.sender.sent).toHaveLength(0);
  });

  it('último sucesso com mais de 24 h: sem aviso de prazo', async () => {
    const t = await setup();
    t.syncOk = false;
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-17T11:59:00-03:00'), nextRunAt: null });
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    // exatamente 24 h ainda vale
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-17T12:00:00-03:00'), nextRunAt: null });
    expect((await t.run('2026-11-18T12:00:00-03:00')).sent).toBe(1);
  });

  it('cópia RECONNECT_REQUIRED: sem aviso de prazo, mas o de reconexão continua', async () => {
    const t = await setup();
    t.syncOk = false;
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-18T11:00:00-03:00'), nextRunAt: null });
    await t.copy.recordAttempt(U, { result: 'RECONNECT_REQUIRED', at: at('2026-11-18T11:30:00-03:00'), nextRunAt: null });
    t.accounts.rows = [account(at('2026-11-20T12:00:00-03:00'))];
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r.sent).toBe(1);
    expect(t.bodies()).toEqual(['Seu acesso ao SIASB venceu. Reconecte no painel.']); // âncora: última tentativa da cópia
    expect(t.keys().every((k) => k.includes('|connection|'))).toBe(true);
  });

  it('cópia nunca sincronizada não impede o aviso de reconexão', async () => {
    const t = await setup();
    t.syncOk = false;
    t.accounts.rows = [account(at('2026-11-18T18:00:00-03:00'))];
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('SiasbAlerts: canal, ajuste e aparelho', () => {
  it('ajuste desligado: não envia e não registra', async () => {
    const t = await setup();
    await new NotificationSettings(t.settings).set(U, 'siasb.alerts', false);
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
    expect(t.log.rows.size).toBe(0);
    expect(t.sender.sent).toHaveLength(0);
  });

  it('canal indisponível: não envia e não registra', async () => {
    const t = await setup();
    t.sender.enabled = false;
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r.sent + r.failed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(t.log.rows.size).toBe(0);
  });

  it('sem aparelho: skipped 1 e nada é lido (nem a cópia nem a conta)', async () => {
    const t = await setup();
    for (const d of await t.devices.list(U)) await t.devices.remove(U, d.id);
    t.accounts.rows = [account(at('2026-11-20T12:00:00-03:00'))];
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 1, failed: 0 });
    expect(t.situationCalls).toBe(0);
    expect(t.accounts.reads).toBe(0);
    expect(t.log.rows.size).toBe(0);
  });

  it('o aparelho recusa (failed): conta failed, devolve o instante e tenta de novo na próxima rodada', async () => {
    const t = await setup();
    t.sender.outcomes.set(FCM(1), 'failed');
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toEqual({ sent: 0, suppressed: 0, skipped: 0, failed: 1 });
    expect(t.log.rows.size).toBe(0);
    t.sender.outcomes.delete(FCM(1));
    expect((await t.run('2026-11-18T12:15:00-03:00')).sent).toBe(1);
  });
});

describe('SiasbAlerts: aviso de reconexão', () => {
  const E = at('2026-11-30T12:00:00-03:00');

  it('7, 3 e 1 dia antes, no vencimento e a cada 36 h depois (silêncio não move o instante)', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [account(E)];
    expect((await t.run('2026-11-22T12:00:00-03:00')).sent).toBe(0);
    expect((await t.run('2026-11-23T12:00:00-03:00')).sent).toBe(1);
    expect((await t.run('2026-11-23T12:00:00-03:00')).sent).toBe(0);
    expect((await t.run('2026-11-27T12:05:00-03:00')).sent).toBe(1);
    expect((await t.run('2026-11-29T12:05:00-03:00')).sent).toBe(1);
    expect((await t.run('2026-11-30T12:05:00-03:00')).sent).toBe(1);
    // vencimento + 36 h = 02/12 00:00, no silêncio: não envia, não registra, e envia às 07:00
    const rows = t.log.rows.size;
    expect((await t.run('2026-12-02T03:00:00-03:00')).sent).toBe(0);
    expect(t.log.rows.size).toBe(rows);
    expect((await t.run('2026-12-02T07:00:00-03:00')).sent).toBe(1);
    expect(t.keys().pop()).toBe(`siasb.alerts|connection|${at('2026-12-02T00:00:00-03:00').toISOString()}`);
    expect(t.bodies()).toEqual([
      'Seu acesso ao SIASB vence em 7 dias. Reconecte no painel.',
      'Seu acesso ao SIASB vence em 3 dias. Reconecte no painel.',
      'Seu acesso ao SIASB vence em 1 dia. Reconecte no painel.',
      'Seu acesso ao SIASB venceu. Reconecte no painel.',
      'Seu acesso ao SIASB venceu. Reconecte no painel.',
    ]);
    expect(JSON.parse(t.sender.sent[0].payload)).toMatchObject({ title: 'SIASB', tag: 'siasb-connection', url: '/' });
  });

  it('rajada: depois de uma queda envia só o mais recente e grava os anteriores como suppressed', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [account(E)];
    await t.run('2026-11-23T12:00:00-03:00');
    const r = await t.run('2026-12-04T12:00:00-03:00');
    expect(r).toEqual({ sent: 1, suppressed: 4, skipped: 0, failed: 0 });
    expect(t.sender.sent).toHaveLength(2);
    expect((await t.run('2026-12-04T12:10:00-03:00')).sent).toBe(0);
  });

  it('primeira vez já passado do vencimento: só o instante mais recente', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [account(E)];
    await t.run('2026-12-04T12:00:00-03:00');
    expect(t.sender.sent).toHaveLength(1);
    expect(t.bodies()[0]).toBe('Seu acesso ao SIASB venceu. Reconecte no painel.');
  });

  it('sem conta, ou conta sem vencimento: nada', async () => {
    const t = await setup();
    t.items = [];
    await t.run('2026-11-29T12:00:00-03:00');
    t.accounts.rows = [account(null)];
    await t.run('2026-11-29T12:00:00-03:00');
    expect(t.sender.sent).toHaveLength(0);
    expect(t.log.rows.size).toBe(0);
  });

  it('reconectar (novo vencimento longe) não gera aviso pendente', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [account(E)];
    await t.run('2026-11-23T12:00:00-03:00');
    t.accounts.rows = [account(at('2027-05-30T12:00:00-03:00'))];
    expect((await t.run('2026-11-28T12:00:00-03:00')).sent).toBe(0);
  });
});

describe('SiasbAlerts: privacidade e robustez', () => {
  it('nenhuma mensagem, subject nem tag contém o primeiro nome do paciente (cópia real com nome cifrado)', async () => {
    const t = await setup();
    const NOME = 'Zeferina';
    const cipher = new AadCipher();
    class Cal extends AcademicCalendar {
      async holidays() {
        return { known: false, dates: [] as string[] };
      }
    }
    const att: SyncedAttendance = {
      id: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clínica Integrada I',
      treatmentType: 'PLANNING',
      concluded: false,
      active: true,
      firstName: cipher.encrypt(NOME, `siasb-attendance:${U}:a1`),
    };
    const ses = (id: string, start: string): SyncedSession => ({
      id,
      attendanceId: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clínica Integrada I',
      professorName: `Profa. ${NOME}`,
      locationName: 'Sala 1',
      startAt: at(start),
      endAt: at(new Date(at(start).getTime() + HOUR).toISOString()),
      rescheduledStartAt: null,
      statusLabel: 'Atendido',
    });
    await t.copy.replaceWindow(
      U,
      { from: at('2026-09-01T00:00:00Z'), to: at('2026-12-31T00:00:00Z') },
      {
        disciplines: [{ id: 'd1', name: 'Clínica Integrada I' }],
        attendances: [att],
        sessions: [ses('s1', '2026-10-30T14:00:00-03:00'), ses('s2', '2026-11-06T14:00:00-03:00'), ses('s3', '2026-11-13T14:00:00-03:00')],
      },
    );
    t.clock.now = at('2026-11-18T12:00:00-03:00');
    const real = new SiasbCopyReader(t.copy, cipher, new Cal(), () => t.clock.now);
    const alerts = new SiasbAlerts(real, t.copy, t.notifier, t.accounts);
    await t.copy.recordAttempt(U, { result: 'OK', at: new Date(t.clock.now.getTime() - 60_000), nextRunAt: null });
    expect((await alerts.evaluateUser(U, t.clock.now)).sent).toBe(1);
    expect(t.bodies()[0]).toMatch(/^Você tem paciente em Clínica Integrada I, mas a clínica de sexta ainda está sem sessão\. Prazo estimado: /);
    const everything = JSON.stringify([t.sender.sent, [...t.log.rows.keys()]]);
    expect(everything).not.toContain(NOME);
  });

  it('nunca lança: a cópia falha (sem mensagem com dados), a conta falha, o Notifier falha', async () => {
    const t = await setup();
    t.reader = {
      situation: async () => {
        throw new Error('falha com Zeferina');
      },
    } as unknown as SiasbCopyReader;
    t.alerts = new SiasbAlerts(t.reader, t.copy, t.notifier, t.accounts);
    await expect(t.run('2026-11-18T12:00:00-03:00')).resolves.toEqual({ sent: 0, suppressed: 0, skipped: 0, failed: 1 });

    const t2 = await setup();
    jest.spyOn(t2.notifier, 'send').mockRejectedValue(new Error('boom'));
    await expect(t2.run('2026-11-18T12:00:00-03:00')).resolves.toMatchObject({ sent: 0, failed: 1 });

    const t3 = await setup();
    jest.spyOn(t3.notifier, 'hasDevices').mockRejectedValue(new Error('boom'));
    await expect(t3.run('2026-11-18T12:00:00-03:00')).resolves.toEqual({ sent: 0, suppressed: 0, skipped: 0, failed: 1 });

    const t4 = await setup();
    t4.items = [];
    t4.accounts.findByUserAndProvider = async () => {
      throw new Error('boom');
    };
    await expect(t4.run('2026-11-18T12:00:00-03:00')).resolves.toMatchObject({ failed: 1 });
  });
});

function clockSet(t: { clock: { now: Date } }, when: string) {
  t.clock.now = at(when);
}

describe('SiasbAlerts: ajustes finais', () => {
  const PREV1 = { slot: SLOT_F, deadline: D, covered: false };
  const perdidoOf = (t: { bodies: () => string[] }) => t.bodies().filter((b) => b.startsWith('Prazo perdido'));

  it('#1 a rodada do "perdido" não manda também o primeiro aviso do episódio novo; a rodada seguinte não manda nada', async () => {
    const t = await setup();
    await t.run('2026-11-19T19:30:00-03:00');
    t.items = [item({ nextSlot: at('2026-11-27T14:00:00-03:00'), deadline: at('2026-11-27T10:00:00-03:00') })];
    t.previous = { d1: PREV1 };
    expect((await t.run('2026-11-20T11:00:00-03:00')).sent).toBe(1);
    expect(t.sender.sent).toHaveLength(2);
    expect((await t.run('2026-11-20T11:15:00-03:00')).sent).toBe(0);
    expect(t.sender.sent).toHaveLength(2);
    // todos os avisos da disciplina usam a mesma tag (um substitui o outro no aparelho)
    expect(t.sender.sent.map((s) => JSON.parse(s.payload).tag)).toEqual(['siasb-disc:d1', 'siasb-disc:d1']);
  });

  it('#2 cópia sincronizada ANTES do prazo: sem "perdido"; sincronizada depois dele: sai', async () => {
    const t = await setup();
    await t.run('2026-11-19T19:30:00-03:00');
    t.items = [item({ nextSlot: at('2026-11-26T14:00:00-03:00'), deadline: at('2026-11-26T10:00:00-03:00') })];
    t.previous = { d1: PREV1 };
    t.syncOk = false;
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-20T09:30:00-03:00'), nextRunAt: null });
    t.clock.now = at('2026-11-20T10:30:00-03:00');
    await t.alerts.evaluateUser(U, t.clock.now);
    expect(perdidoOf(t)).toEqual([]);
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-20T10:20:00-03:00'), nextRunAt: null });
    await t.alerts.evaluateUser(U, t.clock.now);
    expect(perdidoOf(t)).toHaveLength(1);
  });

  it('#3 o episódio é o horário da clínica: o prazo deslocar um dia útil gera no máximo um aviso a mais, nunca um episódio novo', async () => {
    const t = await setup();
    await t.run('2026-11-18T12:00:00-03:00'); // prazo D = sexta 20/11 10h
    t.items = [item({ deadline: at('2026-11-21T10:00:00-03:00') })]; // prazo deslocado, mesmo horário (nextSlot)
    await t.run('2026-11-18T12:05:00-03:00');
    await t.run('2026-11-19T07:10:00-03:00'); // instante novo da cadeia deslocada
    const subjects = new Set(t.keys().map((k) => k.split('|')[1]));
    expect(subjects).toEqual(new Set([SUBJECT]));
    expect(t.sender.sent).toHaveLength(2);
  });

  it('#5 cópia pede reconexão e o vencimento está a 20 dias: o aviso "venceu" sai já (âncora: última tentativa) e repete a cada 36 h', async () => {
    const t = await setup();
    t.syncOk = false;
    await t.copy.recordAttempt(U, { result: 'OK', at: at('2026-11-18T11:00:00-03:00'), nextRunAt: null });
    await t.copy.recordAttempt(U, { result: 'RECONNECT_REQUIRED', at: at('2026-11-18T11:30:00-03:00'), nextRunAt: null });
    t.accounts.rows = [account(at('2026-12-08T12:00:00-03:00'))];
    expect((await t.run('2026-11-18T12:00:00-03:00')).sent).toBe(1);
    expect(t.bodies()).toEqual(['Seu acesso ao SIASB venceu. Reconecte no painel.']);
    expect((await t.run('2026-11-19T12:00:00-03:00')).sent).toBe(0);
    expect((await t.run('2026-11-20T07:00:00-03:00')).sent).toBe(1); // 11:30 + 36 h = 00:30 (silêncio) vale na rodada das 07h
  });

  it('#5 conta em REAUTH_NEEDED: o mesmo; sem linha de estado não há âncora (nada a adivinhar); saudável com vencimento longe: nada', async () => {
    const t = await setup();
    t.items = [];
    t.accounts.rows = [{ ...account(at('2026-12-08T12:00:00-03:00')), status: 'REAUTH_NEEDED' }];
    expect((await t.run('2026-11-18T12:00:00-03:00')).sent).toBe(1);
    expect(t.bodies()).toEqual(['Seu acesso ao SIASB venceu. Reconecte no painel.']);

    const semEstado = await setup();
    semEstado.items = [];
    await semEstado.copy.deleteAll(U);
    semEstado.syncOk = false;
    semEstado.accounts.rows = [{ ...account(at('2026-12-08T12:00:00-03:00')), status: 'REAUTH_NEEDED' }];
    await semEstado.run('2026-11-18T12:00:00-03:00');
    expect(semEstado.sender.sent).toHaveLength(0);

    const ok = await setup();
    ok.items = [];
    ok.accounts.rows = [account(at('2026-12-08T12:00:00-03:00'))];
    await ok.run('2026-11-18T12:00:00-03:00');
    expect(ok.sender.sent).toHaveLength(0);
  });

  it('reconectar (resetState às 06:50) com a cópia em RECONNECT_REQUIRED e vencimento longe: NÃO há "venceu" às 07:00', async () => {
    const setupBroken = async () => {
      const t = await setup();
      t.items = [];
      t.syncOk = false;
      await t.copy.recordAttempt(U, { result: 'RECONNECT_REQUIRED', at: at('2026-11-18T23:00:00-03:00'), nextRunAt: null });
      t.accounts.rows = [account(at('2026-12-08T12:00:00-03:00'))];
      return t;
    };
    // controle: sem reconectar, a âncora antiga faz o "venceu" sair às 07:00
    const control = await setupBroken();
    expect((await control.run('2026-11-19T07:00:00-03:00')).sent).toBe(1);
    expect(control.bodies()).toEqual(['Seu acesso ao SIASB venceu. Reconecte no painel.']);
    // reconectou: o estado é zerado e o vencimento declarado vale
    const t = await setupBroken();
    t.clock.now = at('2026-11-19T06:50:00-03:00');
    await t.copy.resetState(U);
    expect((await t.run('2026-11-19T07:00:00-03:00')).sent).toBe(0);
    expect(t.sender.sent).toHaveLength(0);
  });

  it('m1 uma disciplina que falha não derruba as outras (conta failed)', async () => {
    const t = await setup();
    t.items = [item(), item({ disciplineId: 'd2', disciplineName: 'Clínica Integrada II' })];
    const original = t.notifier.lastSentAt.bind(t.notifier);
    jest.spyOn(t.notifier, 'lastSentAt').mockImplementation(async (u, k, s) => {
      if (s.startsWith('disc:d1:')) throw new Error('boom');
      return original(u, k, s);
    });
    const r = await t.run('2026-11-18T12:00:00-03:00');
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(t.bodies()[0]).toContain('Clínica Integrada II');
  });
});
