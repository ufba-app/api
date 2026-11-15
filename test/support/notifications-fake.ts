import { createHash } from 'node:crypto';
import { SecretCipher } from '../../src/application/ports/secret-cipher';
import type { EncryptedSecret } from '../../src/application/ports/repositories';
import {
  AlertLogRepository,
  NotificationSettingRepository,
  PushDeviceRepository,
  PushSender,
  type NewPushDevice,
  type PushDeviceRow,
  type PushOutcome,
  type PushSubscriptionData,
} from '../../src/application/ports/notifications';

/** Aparelhos em memória (mesma semântica do Postgres: endpoint_hash único). */
export class InMemoryPushDevices extends PushDeviceRepository {
  rows = new Map<string, PushDeviceRow & { endpointHash: string }>();

  async findByEndpointHash(hash: string) {
    const r = [...this.rows.values()].find((d) => d.endpointHash === hash);
    return r ? { id: r.id, userId: r.userId } : null;
  }
  async count(userId: string) {
    return [...this.rows.values()].filter((d) => d.userId === userId).length;
  }
  async list(userId: string) {
    return [...this.rows.values()].filter((d) => d.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async find(userId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.userId === userId ? r : null;
  }
  async create(d: NewPushDevice) {
    if ([...this.rows.values()].some((x) => x.endpointHash === d.endpointHash)) return false;
    this.rows.set(d.id, { id: d.id, userId: d.userId, label: d.label, createdAt: d.createdAt, lastSuccessAt: null, secret: d.secret, endpointHash: d.endpointHash });
    return true;
  }
  async setLabel(userId: string, id: string, label: string | null) {
    const r = this.rows.get(id);
    if (r && r.userId === userId) r.label = label;
  }
  async delete(userId: string, id: string) {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId) return false;
    this.rows.delete(id);
    return true;
  }
  async deleteById(id: string) {
    this.rows.delete(id);
  }
  async touchSuccess(id: string, at: Date) {
    const r = this.rows.get(id);
    if (r) r.lastSuccessAt = at;
  }
}

export class InMemoryNotificationSettings extends NotificationSettingRepository {
  rows = new Map<string, boolean>();
  async list(userId: string) {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${userId}|`)).map(([k, enabled]) => ({ key: k.slice(userId.length + 1), enabled }));
  }
  async set(userId: string, key: string, enabled: boolean) {
    this.rows.set(`${userId}|${key}`, enabled);
  }
}

/** `claim` é síncrono por dentro (como o insert com chave única): duas chamadas simultâneas, uma só ganha. */
export class InMemoryAlertLog extends AlertLogRepository {
  rows = new Map<string, { sentAt: Date; suppressed: boolean }>();
  private k = (u: string, key: string, s: string, at: Date) => `${u}|${key}|${s}|${at.toISOString()}`;
  async claim(userId: string, key: string, subject: string, slotAt: Date, sentAt: Date, suppressed: boolean) {
    const k = this.k(userId, key, subject, slotAt);
    if (this.rows.has(k)) return false;
    this.rows.set(k, { sentAt, suppressed });
    return true;
  }
  async release(userId: string, key: string, subject: string, slotAt: Date) {
    this.rows.delete(this.k(userId, key, subject, slotAt));
  }
  async lastSentAt(userId: string, key: string, subject: string) {
    const prefix = `${userId}|${key}|${subject}|`;
    const dates = [...this.rows.entries()].filter(([k, v]) => k.startsWith(prefix) && !v.suppressed).map(([, v]) => v.sentAt.getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  }
}

/** Provedor de push falso: registra o que recebeu e devolve o resultado programado por endpoint. */
export class FakePushSender extends PushSender {
  enabled = true;
  publicKey: string | null = 'BFakePublicKeyForTests';
  sent: Array<{ subscription: PushSubscriptionData; payload: string; options: { ttlSeconds: number; urgency: 'high' } }> = [];
  outcomes = new Map<string, PushOutcome>();
  async send(subscription: PushSubscriptionData, payload: string, options: { ttlSeconds: number; urgency: 'high' }): Promise<PushOutcome> {
    this.sent.push({ subscription, payload, options });
    return this.outcomes.get(subscription.endpoint) ?? 'ok';
  }
}

/**
 * Cifra falsa para os testes da camada `application` (que não importa `infrastructure`): embaralha o texto e AMARRA o
 * resultado ao `aad` (sem o mesmo `aad`, não abre), como o AES-GCM de verdade.
 */
export class AadCipher extends SecretCipher {
  private tag = (aad: string | undefined, ciphertext: string) => createHash('sha256').update(`${aad ?? ''}|${ciphertext}`).digest('base64');
  encrypt(plain: string, aad?: string): EncryptedSecret {
    const ciphertext = Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)).toString('base64');
    return { ciphertext, iv: 'iv', authTag: this.tag(aad, ciphertext) };
  }
  decrypt(secret: EncryptedSecret, aad?: string): string {
    if (secret.authTag !== this.tag(aad, secret.ciphertext)) throw new Error('aad');
    return Buffer.from(Buffer.from(secret.ciphertext, 'base64').map((b) => b ^ 0x5a)).toString('utf8');
  }
}
