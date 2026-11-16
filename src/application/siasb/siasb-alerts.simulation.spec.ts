import { AadCipher, FakePushSender, InMemoryAlertLog, InMemoryNotificationSettings, InMemoryPushDevices } from '../../../test/support/notifications-fake';
import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import { inQuietHours } from '../../domain/notifications/quiet-hours';
import { NotificationSettings } from '../notifications/notification-settings.service';
import { Notifier } from '../notifications/notifier';
import { PushDevices } from '../notifications/push-devices.service';
import { AcademicCalendar } from '../ports/academic-calendar';
import { SourceAccountRepository } from '../ports/repositories';
import type { SyncedAttendance, SyncedSession } from '../ports/siasb-copy';
import { SiasbAlerts } from './siasb-alerts';
import { SiasbCopyReader } from './siasb-copy-reader';

/**
 * Simulação de uma semana e meia, de 15 em 15 minutos, com o leitor real da cópia, o Notifier real e a cópia em memória:
 * uma aluna com um horário semanal de clínica (sextas, 14h da Bahia). A cópia sincroniza a cada 45 minutos.
 */
const U = 'sim-user';
const at = (s: string) => new Date(s);
const MIN = 60_000;
const START = at('2026-11-16T06:00:00-03:00'); // segunda
const END = at('2026-11-26T12:00:00-03:00');
const SLOT_20 = at('2026-11-20T14:00:00-03:00'); // prazo: terça 17/11 14h (calendário sem margem desconhecida: 1 dia útil a mais)
const SLOT_27 = at('2026-11-27T14:00:00-03:00'); // prazo: terça 24/11 14h
const DEADLINE_20 = at('2026-11-17T14:00:00-03:00');

class NoAccounts extends SourceAccountRepository {
  async upsert(): Promise<never> {
    throw new Error('não usado');
  }
  async findByUserAndProvider() {
    return [];
  }
  async listByUser() {
    return [];
  }
  async setStatus() {}
  async updateSecret() {}
  async delete() {}
}

class Cal extends AcademicCalendar {
  async holidays() {
    return { known: false, dates: [] as string[] };
  }
}

interface Push {
  at: Date;
  body: string;
  tag: string;
}

async function simulate(booking: { visibleAtSync: Date } | null) {
  const clock = { now: START };
  const now = () => clock.now;
  const sender = new FakePushSender();
  const log = new InMemoryAlertLog();
  const devices = new PushDevices(new InMemoryPushDevices(), sender, new AadCipher(), now);
  const notifier = new Notifier(sender, new NotificationSettings(new InMemoryNotificationSettings(), now), devices, log, now);
  await devices.register(U, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sim', keys: { p256dh: 'p', auth: 'a' } } });
  const copy = new InMemorySiasbCopy();
  copy.accounts.set(U, 'OK');
  copy.seedState(U);
  const cipher = new AadCipher();
  const attendance: SyncedAttendance = {
    id: 'a1',
    disciplineId: 'd1',
    disciplineName: 'Clínica Integrada I',
    treatmentType: 'PLANNING',
    concluded: false,
    active: true,
    firstName: cipher.encrypt('Zeferina', `siasb-attendance:${U}:a1`),
  };
  const session = (id: string, start: Date, label: string): SyncedSession => ({
    id,
    attendanceId: 'a1',
    disciplineId: 'd1',
    disciplineName: 'Clínica Integrada I',
    professorName: 'Profa. Teste',
    locationName: 'Sala 1',
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    rescheduledStartAt: null,
    statusLabel: label,
  });
  const history = [
    session('h1', at('2026-10-30T14:00:00-03:00'), 'Atendido'),
    session('h2', at('2026-11-06T14:00:00-03:00'), 'Atendido'),
    session('h3', at('2026-11-13T14:00:00-03:00'), 'Atendido'),
  ];
  const load = (booked: boolean) =>
    copy.replaceWindow(
      U,
      { from: at('2026-09-01T00:00:00Z'), to: at('2026-12-31T00:00:00Z') },
      {
        disciplines: [{ id: 'd1', name: 'Clínica Integrada I' }],
        attendances: [attendance],
        sessions: booked ? [...history, session('b1', SLOT_20, 'Confirmado')] : history,
      },
    );
  await load(false);
  const alerts = new SiasbAlerts(new SiasbCopyReader(copy, cipher, new Cal(), now), copy, notifier, new NoAccounts());

  const pushes: Push[] = [];
  const perTick: number[] = [];
  const perdidoTicks: Date[] = [];
  let tick = 0;
  for (let t = START.getTime(); t <= END.getTime(); t += 15 * MIN, tick++) {
    clock.now = new Date(t);
    // sincronização a cada 45 minutos (a marcação só aparece na primeira sincronização depois dela)
    if (tick % 3 === 0) {
      await load(booking !== null && clock.now.getTime() >= booking.visibleAtSync.getTime());
      await copy.recordAttempt(U, { result: 'OK', at: clock.now, nextRunAt: null });
    }
    const before = sender.sent.length;
    await alerts.evaluateUser(U, clock.now);
    const fresh = sender.sent.slice(before).map((s) => JSON.parse(s.payload) as { body: string; tag: string });
    perTick.push(fresh.length);
    for (const p of fresh) {
      pushes.push({ at: clock.now, body: p.body, tag: p.tag });
      if (p.body.startsWith('Prazo perdido')) perdidoTicks.push(clock.now);
    }
  }
  return { pushes, perTick, perdidoTicks, log, sender };
}

describe('SiasbAlerts: simulação de uma semana e meia (15 em 15 minutos)', () => {
  it('aluna que nunca marca: silêncio respeitado, um aviso por rodada, um "perdido" por horário perdido, sem duplicata', async () => {
    const sim = await simulate(null);

    // (1) nenhum push entre 22h e 7h da Bahia
    expect(sim.pushes.length).toBeGreaterThan(3);
    for (const p of sim.pushes) expect(inQuietHours(p.at)).toBe(false);

    // (2) no máximo um push por disciplina por rodada
    expect(Math.max(...sim.perTick)).toBeLessThanOrEqual(1);

    // (3) exatamente um "Prazo perdido" por horário perdido (sextas 20/11 e 27/11 => prazos de terça 17/11 e 24/11)
    const perdidos = sim.pushes.filter((p) => p.body.startsWith('Prazo perdido'));
    expect(perdidos).toHaveLength(2);
    expect(perdidos[0].at.getTime()).toBeGreaterThan(DEADLINE_20.getTime());
    expect(perdidos[0].at.getTime()).toBeLessThanOrEqual(DEADLINE_20.getTime() + 72 * 3_600_000);
    expect(perdidos[0].body).toBe('Prazo perdido em Clínica Integrada I. Próxima chance: terça, 24/11, às 14h.');

    // (5) sem duplicata: cada instante reivindicado no log corresponde a UM envio (ou a um registro, nunca a dois)
    const sentRows = [...sim.log.rows.values()].filter((v) => !v.suppressed).length;
    const recordedOnly = 2; // o primeiro aviso de cada episódio novo, anotado na rodada do "perdido"
    expect(sim.sender.sent.length).toBe(sentRows - recordedOnly);

    // (6) na rodada do "perdido" sai só ele; o aviso do episódio novo foi anotado, não enviado
    for (const when of sim.perdidoTicks) {
      expect(sim.pushes.filter((p) => p.at.getTime() === when.getTime())).toHaveLength(1);
    }
    // nada sai entre o prazo e o "perdido" (o primeiro aviso do episódio novo espera a sincronização e é só anotado)
    expect(sim.pushes.filter((p) => p.at.getTime() >= DEADLINE_20.getTime() && p.at.getTime() <= perdidos[0].at.getTime())).toHaveLength(1);
    const next = [...sim.log.rows.keys()].filter((k) => k.includes(`|disc:d1:${SLOT_27.toISOString()}|`));
    expect(next.length).toBeGreaterThanOrEqual(1);

    // uma só tag por disciplina: a notificação nova substitui a anterior
    expect(new Set(sim.pushes.map((p) => p.tag))).toEqual(new Set(['siasb-disc:d1']));
  });

  it('marcação que entra na cópia só depois do prazo (sincronização anterior ao prazo): NÃO há "perdido" dela', async () => {
    // a aluna marcou a sessão de 20/11 minutos antes do prazo; a cópia só a mostra na sincronização das 14:15
    const sim = await simulate({ visibleAtSync: at('2026-11-17T14:15:00-03:00') });
    const perdidos = sim.pushes.filter((p) => p.body.startsWith('Prazo perdido'));
    // só o do horário seguinte (27/11, prazo 24/11), nunca o de 20/11
    expect(perdidos).toHaveLength(1);
    expect(perdidos[0].at.getTime()).toBeGreaterThan(at('2026-11-24T14:00:00-03:00').getTime());
    for (const p of sim.pushes) expect(inQuietHours(p.at)).toBe(false);
    expect(Math.max(...sim.perTick)).toBeLessThanOrEqual(1);
  });
});
