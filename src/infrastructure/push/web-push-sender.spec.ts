import webpush from 'web-push';
import { WebPushSender } from './web-push-sender';

const keys = webpush.generateVAPIDKeys();
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  VAPID_SUBJECT: 'mailto:avisos@ufba.app',
  ...over,
});
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

describe('WebPushSender', () => {
  it('liga só com as três variáveis válidas e expõe só a chave pública', () => {
    const s = new WebPushSender(env());
    expect(s.enabled).toBe(true);
    expect(s.publicKey).toBe(keys.publicKey);
    expect(JSON.stringify(s)).not.toContain(keys.privateKey);
    expect(Object.keys(s)).not.toContain('privateKey');
  });

  it.each([
    ['sem a pública', { VAPID_PUBLIC_KEY: undefined }],
    ['sem a privada', { VAPID_PRIVATE_KEY: undefined }],
    ['sem o subject', { VAPID_SUBJECT: undefined }],
    ['subject que não é mailto: nem https:', { VAPID_SUBJECT: 'avisos@ufba.app' }],
    ['chave pública inválida', { VAPID_PUBLIC_KEY: 'nao-e-chave' }],
    ['chave privada inválida', { VAPID_PRIVATE_KEY: 'nao-e-chave' }],
  ])('desligado: %s (sem lançar)', (_nome, over) => {
    const s = new WebPushSender(env(over));
    expect(s.enabled).toBe(false);
    expect(s.publicKey).toBeNull();
  });

  it('desligado, send devolve failed sem tentar a rede', async () => {
    const spy = jest.spyOn(webpush, 'sendNotification');
    expect(await new WebPushSender({}).send(SUB, '{}', { ttlSeconds: 1, urgency: 'high' })).toBe('failed');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('envia com TTL, urgência e as chaves VAPID; 404/410 = gone; outro erro = failed (e nenhum erro vaza)', async () => {
    const s = new WebPushSender(env());
    const spy = jest.spyOn(webpush, 'sendNotification');
    spy.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    expect(await s.send(SUB, '{"title":"t"}', { ttlSeconds: 21600, urgency: 'high' })).toBe('ok');
    const [sub, payload, opts] = spy.mock.calls[0];
    expect(sub).toEqual({ endpoint: SUB.endpoint, keys: { p256dh: SUB.p256dh, auth: SUB.auth } });
    expect(payload).toBe('{"title":"t"}');
    expect(opts).toMatchObject({ TTL: 21600, urgency: 'high', vapidDetails: { subject: 'mailto:avisos@ufba.app', publicKey: keys.publicKey } });

    const err = (statusCode: number) => Object.assign(new Error(`falhou com ${SUB.endpoint}`), { statusCode });
    spy.mockRejectedValueOnce(err(410));
    expect(await s.send(SUB, '{}', { ttlSeconds: 1, urgency: 'high' })).toBe('gone');
    spy.mockRejectedValueOnce(err(404));
    expect(await s.send(SUB, '{}', { ttlSeconds: 1, urgency: 'high' })).toBe('gone');
    spy.mockRejectedValueOnce(err(500));
    expect(await s.send(SUB, '{}', { ttlSeconds: 1, urgency: 'high' })).toBe('failed');
    spy.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await s.send(SUB, '{}', { ttlSeconds: 1, urgency: 'high' })).toBe('failed');
    spy.mockRestore();
  });
});

describe('WebPushSender: a chave privada não sai em objeto logado', () => {
  it('nem JSON.stringify, nem util.inspect, nem String()', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { inspect } = require('node:util') as typeof import('node:util');
    const s = new WebPushSender(env());
    for (const text of [JSON.stringify(s), inspect(s, { depth: 10, showHidden: true }), String(s)]) expect(text).not.toContain(keys.privateKey);
  });
});
