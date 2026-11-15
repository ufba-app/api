import { AadCipher, FakePushSender, InMemoryAlertLog, InMemoryNotificationSettings, InMemoryPushDevices } from '../../../test/support/notifications-fake';
import { NotificationSettings } from './notification-settings.service';
import { Notifier, type NotifyMessage } from './notifier';
import { PushDevices } from './push-devices.service';

const FCM = (n: number) => `https://fcm.googleapis.com/fcm/send/dispositivo-${n}`;
const sub = (n: number) => ({ endpoint: FCM(n), keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });
const U = '0192e0aa-0000-7000-8000-000000000001';

// 12:00 na Bahia: acordado.
const AWAKE = new Date('2026-11-18T12:00:00-03:00');

function setup(now: () => Date = () => AWAKE) {
  const sender = new FakePushSender();
  const repo = new InMemoryPushDevices();
  const settings = new InMemoryNotificationSettings();
  const log = new InMemoryAlertLog();
  const cipher = new AadCipher();
  const devices = new PushDevices(repo, sender, cipher, now);
  const notifier = new Notifier(sender, new NotificationSettings(settings, now), devices, log, now);
  return { sender, repo, settings, log, devices, notifier, setNow: (_: Date) => undefined };
}

const msg = (over: Partial<NotifyMessage> = {}): NotifyMessage => ({
  key: 'siasb.alerts',
  subject: 'disc-1',
  slotAt: new Date('2026-11-18T12:00:00-03:00'),
  title: 'Prazo estimado',
  body: 'Falta marcar a sessão da disciplina.',
  tag: 'siasb-disc-1',
  url: '/siasb',
  ...over,
});

describe('Notifier.send', () => {
  it('envia para o aparelho com title, body, tag e url, TTL de 6 h e urgência alta (e nada além disso)', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    expect(await t.notifier.send(U, msg())).toBe('sent');
    expect(t.sender.sent).toHaveLength(1);
    expect(JSON.parse(t.sender.sent[0].payload)).toEqual({ title: 'Prazo estimado', body: 'Falta marcar a sessão da disciplina.', tag: 'siasb-disc-1', url: '/siasb' });
    expect(t.sender.sent[0].options).toEqual({ ttlSeconds: 6 * 3600, urgency: 'high' });
    expect([...t.repo.rows.values()][0].lastSuccessAt).toEqual(AWAKE);
  });

  it('url que não é caminho do painel nem https é descartada', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    await t.notifier.send(U, msg({ url: 'javascript:alert(1)', slotAt: new Date(1) }));
    await t.notifier.send(U, msg({ url: '//evil.test/x', slotAt: new Date(2) }));
    for (const s of t.sender.sent) expect(JSON.parse(s.payload).url).toBeUndefined();
  });

  it('canal desligado: unavailable (não registra nada)', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    t.sender.enabled = false;
    expect(await t.notifier.send(U, msg())).toBe('unavailable');
    expect(t.log.rows.size).toBe(0);
  });

  it('ajuste desligado: disabled; ligado de novo volta a enviar. Sem linha vale o padrão do catálogo (ligado)', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    await new NotificationSettings(t.settings).set(U, 'siasb.alerts', false);
    expect(await t.notifier.send(U, msg())).toBe('disabled');
    expect(t.sender.sent).toHaveLength(0);
    await new NotificationSettings(t.settings).set(U, 'siasb.alerts', true);
    expect(await t.notifier.send(U, msg())).toBe('sent');
  });

  it('sem aparelho: no_device (não registra, então um aparelho novo ainda recebe esse aviso)', async () => {
    const t = setup();
    expect(await t.notifier.send(U, msg())).toBe('no_device');
    expect(t.log.rows.size).toBe(0);
    expect(await t.notifier.hasDevices(U)).toBe(false);
    await t.devices.register(U, { subscription: sub(1) });
    expect(await t.notifier.hasDevices(U)).toBe(true);
    expect(await t.notifier.send(U, msg())).toBe('sent');
  });

  it.each([
    ['21:59', 'sent'],
    ['22:00', 'quiet'],
    ['06:59', 'quiet'],
    ['07:00', 'sent'],
  ])('silêncio 22h-7h na Bahia: às %s → %s (quiet não envia e não registra)', async (hhmm, expected) => {
    const t = setup(() => new Date(`2026-11-18T${hhmm}:00-03:00`));
    await t.devices.register(U, { subscription: sub(1) });
    expect(await t.notifier.send(U, msg())).toBe(expected);
    expect(t.log.rows.size).toBe(expected === 'quiet' ? 0 : 1);
    expect(t.sender.sent).toHaveLength(expected === 'quiet' ? 0 : 1);
  });

  it('duplicata: o mesmo (pessoa, tipo, assunto, instante) envia UMA vez só, mesmo em chamadas simultâneas', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    const results = await Promise.all(Array.from({ length: 8 }, () => t.notifier.send(U, msg())));
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(7);
    expect(t.sender.sent).toHaveLength(1);
    // outro instante ou outro assunto é outro aviso
    expect(await t.notifier.send(U, msg({ slotAt: new Date('2026-11-18T13:00:00-03:00') }))).toBe('sent');
    expect(await t.notifier.send(U, msg({ subject: 'disc-2' }))).toBe('sent');
  });

  it('vários aparelhos: todos recebem; um morto (410) é removido e os outros seguem', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    await t.devices.register(U, { subscription: sub(2) });
    t.sender.outcomes.set(FCM(2), 'gone');
    expect(await t.notifier.send(U, msg())).toBe('sent');
    expect(t.sender.sent).toHaveLength(2);
    expect(t.repo.rows.size).toBe(1);
  });

  it('falha de envio: failed, o instante é devolvido e uma nova tentativa envia', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    t.sender.outcomes.set(FCM(1), 'failed');
    expect(await t.notifier.send(U, msg())).toBe('failed');
    expect(t.log.rows.size).toBe(0);
    t.sender.outcomes.clear();
    expect(await t.notifier.send(U, msg())).toBe('sent');
  });

  it('todos os aparelhos mortos: no_device, aparelhos removidos, instante devolvido', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    t.sender.outcomes.set(FCM(1), 'gone');
    expect(await t.notifier.send(U, msg())).toBe('no_device');
    expect(t.repo.rows.size).toBe(0);
    expect(t.log.rows.size).toBe(0);
  });

  it('nunca lança: erro inesperado vira failed', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    jest.spyOn(t.log, 'claim').mockRejectedValueOnce(new Error('banco caiu'));
    expect(await t.notifier.send(U, msg())).toBe('failed');
    jest.spyOn(t.sender, 'send').mockRejectedValueOnce(new Error('rede caiu'));
    expect(await t.notifier.send(U, msg())).toBe('failed');
    expect(t.log.rows.size).toBe(0);
  });

  it('nada vaza em log: endpoint, chaves e texto do aviso não aparecem em nenhuma saída', async () => {
    const out: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' '))));
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true));
    try {
      const t = setup();
      await t.devices.register(U, { subscription: sub(7) });
      t.sender.outcomes.set(FCM(7), 'failed');
      await t.notifier.send(U, msg({ title: 'TITULO-SECRETO', body: 'CORPO-SECRETO' }));
      jest.spyOn(t.log, 'claim').mockRejectedValueOnce(new Error('falha com TITULO-SECRETO'));
      await t.notifier.send(U, msg({ slotAt: new Date(5) }));
      const all = out.join('\n');
      for (const s of ['TITULO-SECRETO', 'CORPO-SECRETO', 'dispositivo-7', 'p256dh-7', 'auth-7']) expect(all).not.toContain(s);
    } finally {
      for (const s of [...spies, stdout, stderr]) s.mockRestore();
    }
  });
});

describe('Notifier.record e lastSentAt', () => {
  it('record grava sem enviar: true na primeira, false depois; o instante gravado bloqueia o envio (duplicate)', async () => {
    const t = setup();
    await t.devices.register(U, { subscription: sub(1) });
    const slot = new Date('2026-11-18T09:00:00-03:00');
    expect(await t.notifier.record(U, 'siasb.alerts', 'disc-1', slot, { suppressed: true })).toBe(true);
    expect(await t.notifier.record(U, 'siasb.alerts', 'disc-1', slot, { suppressed: true })).toBe(false);
    expect(await t.notifier.send(U, msg({ slotAt: slot }))).toBe('duplicate');
    expect(t.sender.sent).toHaveLength(0);
  });

  it('lastSentAt ignora os suprimidos e devolve o envio mais recente (ou null)', async () => {
    let now = new Date('2026-11-18T10:00:00-03:00');
    const t = setup(() => now);
    await t.devices.register(U, { subscription: sub(1) });
    expect(await t.notifier.lastSentAt(U, 'siasb.alerts', 'disc-1')).toBeNull();
    await t.notifier.send(U, msg({ slotAt: new Date(1) }));
    const first = now;
    now = new Date('2026-11-18T15:00:00-03:00');
    await t.notifier.record(U, 'siasb.alerts', 'disc-1', new Date(2), { suppressed: true });
    expect(await t.notifier.lastSentAt(U, 'siasb.alerts', 'disc-1')).toEqual(first);
    await t.notifier.send(U, msg({ slotAt: new Date(3) }));
    expect(await t.notifier.lastSentAt(U, 'siasb.alerts', 'disc-1')).toEqual(now);
    expect(await t.notifier.lastSentAt(U, 'siasb.alerts', 'disc-2')).toBeNull();
  });
});
