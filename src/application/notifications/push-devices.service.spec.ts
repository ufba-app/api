import { AadCipher, FakePushSender, InMemoryPushDevices } from '../../../test/support/notifications-fake';
import { ApiError } from '../web/web-api';
import { isAllowedPushEndpoint } from './push-endpoint';
import { MAX_PUSH_DEVICES, PushDevices } from './push-devices.service';

const A = '0192e0aa-0000-7000-8000-00000000000a';
const B = '0192e0aa-0000-7000-8000-00000000000b';
const FCM = (n: number) => `https://fcm.googleapis.com/fcm/send/aparelho-${n}`;
const sub = (n: number) => ({ endpoint: FCM(n), keys: { p256dh: `p256dh_${n}`, auth: `auth_${n}` } });

function setup() {
  const sender = new FakePushSender();
  const repo = new InMemoryPushDevices();
  let now = new Date('2026-11-18T12:00:00-03:00');
  const devices = new PushDevices(repo, sender, new AadCipher(), () => now);
  return { sender, repo, devices, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : 'erro';
  }
};

describe('isAllowedPushEndpoint', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/x', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/x', true],
    ['https://updates-autopush.push.services.mozilla.com/wpush/v2/x', true],
    ['https://web.push.apple.com/x', true],
    ['https://par01.notify.windows.com/x', true],
    ['http://fcm.googleapis.com/x', false],
    ['https://evil.test/x', false],
    ['https://fcm.googleapis.com.evil.test/x', false],
    ['https://evil.test/https://fcm.googleapis.com/x', false],
    ['https://user:pass@fcm.googleapis.com/x', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://169.254.169.254/latest', false],
    ['https://localhost/x', false],
    ['nao e url', false],
  ])('%s → %s', (url, ok) => expect(isAllowedPushEndpoint(url)).toBe(ok));
});

describe('PushDevices', () => {
  it('registra cifrado: nada da assinatura fica em claro (só o hash do endpoint) e abre de volta com o AAD certo', async () => {
    const t = setup();
    const { id } = await t.devices.register(A, { subscription: sub(1), label: ' Celular ' });
    const row = [...t.repo.rows.values()][0];
    expect(row.label).toBe('Celular');
    const stored = JSON.stringify(row);
    for (const s of ['aparelho-1', 'p256dh_1', 'auth_1', 'fcm.googleapis.com']) expect(stored).not.toContain(s);
    expect(row.endpointHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await t.devices.active(A))[0]).toEqual({ id, subscription: { endpoint: FCM(1), p256dh: 'p256dh_1', auth: 'auth_1' } });
    // O AAD amarra ao dono e ao id: a mesma linha sob outro dono não abre.
    t.repo.rows.set(id, { ...row, userId: B });
    expect(await t.devices.active(B)).toEqual([]);
  });

  it('idempotente por endpoint: mesmo id, sem duplicar; o rótulo novo atualiza', async () => {
    const t = setup();
    const a = await t.devices.register(A, { subscription: sub(1), label: 'um' });
    const b = await t.devices.register(A, { subscription: sub(1), label: 'dois' });
    expect(b).toEqual(a);
    expect(t.repo.rows.size).toBe(1);
    expect([...t.repo.rows.values()][0].label).toBe('dois');
  });

  it('registros simultâneos do mesmo endpoint dão um aparelho só', async () => {
    const t = setup();
    const ids = await Promise.all(Array.from({ length: 5 }, () => t.devices.register(A, { subscription: sub(1) })));
    expect(new Set(ids.map((i) => i.id)).size).toBe(1);
    expect(t.repo.rows.size).toBe(1);
  });

  it(`no máximo ${MAX_PUSH_DEVICES} por pessoa: o 11º dá 409 too_many_devices, mas o mesmo endpoint de novo segue valendo`, async () => {
    const t = setup();
    for (let i = 1; i <= MAX_PUSH_DEVICES; i++) await t.devices.register(A, { subscription: sub(i) });
    expect(await code(t.devices.register(A, { subscription: sub(99) }))).toBe('409:too_many_devices');
    expect(await code(t.devices.register(A, { subscription: sub(3) }))).toBe('ok');
    expect(await code(t.devices.register(B, { subscription: sub(99) }))).toBe('ok');
  });

  it('o mesmo navegador entrando em outra conta muda o aparelho de dono (a primeira pessoa deixa de receber)', async () => {
    const t = setup();
    await t.devices.register(A, { subscription: sub(1) });
    await t.devices.register(B, { subscription: sub(1) });
    expect(await t.devices.list(A)).toEqual([]);
    expect(await t.devices.list(B)).toHaveLength(1);
  });

  it('endpoint fora dos serviços de push: 400 invalid_request e nada é gravado', async () => {
    const t = setup();
    expect(await code(t.devices.register(A, { subscription: { endpoint: 'https://evil.test/x', keys: { p256dh: 'a', auth: 'b' } } }))).toBe('400:invalid_request');
    expect(t.repo.rows.size).toBe(0);
  });

  it('canal desligado: 503 push_unavailable no config, no registro e no teste', async () => {
    const t = setup();
    const { id } = await t.devices.register(A, { subscription: sub(1) });
    t.sender.enabled = false;
    expect(() => t.devices.publicKey()).toThrow(ApiError);
    expect(await code(t.devices.register(A, { subscription: sub(2) }))).toBe('503:push_unavailable');
    expect(await code(t.devices.test(A, id))).toBe('503:push_unavailable');
  });

  it('list nunca devolve endpoint nem chaves', async () => {
    const t = setup();
    await t.devices.register(A, { subscription: sub(1), label: 'x' });
    const json = JSON.stringify(await t.devices.list(A));
    for (const s of ['aparelho-1', 'p256dh_1', 'auth_1', 'endpoint', 'keys']) expect(json).not.toContain(s);
  });

  it('aparelho de outra pessoa: remover e testar dão 404 (igual a inexistente) e não mexem nele', async () => {
    const t = setup();
    const { id } = await t.devices.register(A, { subscription: sub(1) });
    expect(await code(t.devices.remove(B, id))).toBe('404:not_found');
    expect(await code(t.devices.test(B, id))).toBe('404:not_found');
    expect(t.repo.rows.size).toBe(1);
    expect(t.sender.sent).toHaveLength(0);
    await t.devices.remove(A, id);
    expect(t.repo.rows.size).toBe(0);
  });

  it('teste: envia o aviso de teste; provedor diz que morreu → 409 push_device_gone e remove; falha → 503', async () => {
    const t = setup();
    const { id } = await t.devices.register(A, { subscription: sub(1) });
    await t.devices.test(A, id);
    expect(JSON.parse(t.sender.sent[0].payload)).toEqual({ title: 'Teste de aviso', body: expect.any(String), tag: 'ufba-test' });
    expect([...t.repo.rows.values()][0].lastSuccessAt).not.toBeNull();
    t.sender.outcomes.set(FCM(1), 'failed');
    expect(await code(t.devices.test(A, id))).toBe('503:push_unavailable');
    expect(t.repo.rows.size).toBe(1);
    t.sender.outcomes.set(FCM(1), 'gone');
    expect(await code(t.devices.test(A, id))).toBe('409:push_device_gone');
    expect(t.repo.rows.size).toBe(0);
  });

  it('teste: 5 por 10 minutos por pessoa, depois 429 too_many_attempts; a janela passa e libera', async () => {
    const t = setup();
    const { id } = await t.devices.register(A, { subscription: sub(1) });
    for (let i = 0; i < 5; i++) expect(await code(t.devices.test(A, id))).toBe('ok');
    expect(await code(t.devices.test(A, id))).toBe('429:too_many_attempts');
    expect(await code(t.devices.test(B, id))).toBe('404:not_found'); // o limite é por pessoa
    t.advance(10 * 60_000 + 1);
    expect(await code(t.devices.test(A, id))).toBe('ok');
  });
});
