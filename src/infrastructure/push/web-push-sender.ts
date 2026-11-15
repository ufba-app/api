import webpush from 'web-push';
import { PushSender, type PushOutcome, type PushSubscriptionData } from '../../application/ports/notifications';

/**
 * Web Push com VAPID por ambiente. Variáveis (só os NOMES aqui; quem gera e configura é o André): `VAPID_PUBLIC_KEY`,
 * `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` ou `https:`). Faltando uma, ou inválida, o canal fica desligado. A chave
 * privada nunca vai para log, erro nem resposta. Nenhum log aqui: nem endpoint, nem chaves, nem o texto do aviso.
 */
export class WebPushSender extends PushSender {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  /** Campo privado do JavaScript (#): não sai em JSON.stringify nem em util.inspect, então a chave privada não vaza por log de objeto. */
  readonly #vapid: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    super();
    const publicKey = env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = env.VAPID_PRIVATE_KEY?.trim();
    const subject = env.VAPID_SUBJECT?.trim();
    let vapid: { subject: string; publicKey: string; privateKey: string } | null = null;
    if (publicKey && privateKey && subject) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey); // valida o formato; lança sem expor os valores
        vapid = { subject, publicKey, privateKey };
      } catch {
        vapid = null;
      }
    }
    this.#vapid = vapid;
    this.enabled = vapid !== null;
    this.publicKey = vapid ? vapid.publicKey : null;
  }

  async send(
    subscription: PushSubscriptionData,
    payload: string,
    options: { ttlSeconds: number; urgency: 'high' },
  ): Promise<PushOutcome> {
    if (!this.#vapid) return 'failed';
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, {
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        timeout: 10_000,
        vapidDetails: this.#vapid,
      });
      return 'ok';
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? 'gone' : 'failed';
    }
  }
}
