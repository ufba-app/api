import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  SigaaCredentialRepository,
  SigaaVaultRepository,
  type EncryptedSecret,
  type SigaaCredentialRecord,
  type SigaaVaultRecord,
} from '../../src/application/ports/repositories';

/** Cópias da DK por (pessoa, cliente) em memória (mesma semântica do repositório do Postgres). */
export class InMemoryCredentials extends SigaaCredentialRepository {
  readonly rows = new Map<string, SigaaCredentialRecord>();
  private seq = 0;
  private key = (u: string, c: string) => `${u}|${c}`;

  async upsert(i: { userId: string; clientId: string; login: string; secret: EncryptedSecret }) {
    const old = this.rows.get(this.key(i.userId, i.clientId));
    const rec: SigaaCredentialRecord = { id: old?.id ?? `cred${++this.seq}`, ...i, status: 'OK', createdAt: old?.createdAt ?? new Date() };
    this.rows.set(this.key(i.userId, i.clientId), rec);
    return rec;
  }
  async find(userId: string, clientId: string) {
    return this.rows.get(this.key(userId, clientId)) ?? null;
  }
  async setStatus(id: string, status: 'OK' | 'REAUTH_NEEDED') {
    for (const r of this.rows.values()) if (r.id === id) r.status = status;
  }
  async delete(userId: string, clientId: string) {
    this.rows.delete(this.key(userId, clientId));
  }
  async deleteAllExcept(userId: string, clientId: string) {
    for (const [k, r] of this.rows) if (r.userId === userId && r.clientId !== clientId) this.rows.delete(k);
  }
  async deleteAllOf(userId: string) {
    for (const [k, r] of this.rows) if (r.userId === userId) this.rows.delete(k);
  }
  async pruneOldest(userId: string, clientIdPrefix: string, keep: number) {
    const mine = [...this.rows.entries()]
      .filter(([, r]) => r.userId === userId && r.clientId.startsWith(clientIdPrefix))
      .sort((a, b) => b[1].createdAt.getTime() - a[1].createdAt.getTime());
    for (const [k] of mine.slice(keep)) this.rows.delete(k);
  }
}

/** Cofres da senha em memória. */
export class InMemoryVaults extends SigaaVaultRepository {
  readonly rows = new Map<string, SigaaVaultRecord>();

  async find(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async upsert(i: { userId: string; login: string; secret: EncryptedSecret }) {
    const old = this.rows.get(i.userId);
    this.rows.set(i.userId, { ...i, status: 'OK', version: (old?.version ?? 0) + 1, updatedAt: new Date() });
  }
  async setStatus(userId: string, status: 'OK' | 'REAUTH_NEEDED') {
    const r = this.rows.get(userId);
    if (r) r.status = status;
  }
  async delete(userId: string) {
    this.rows.delete(userId);
  }
}

/** AES-256-GCM equivalente ao AesSecretCipher (a camada application não importa infrastructure, nem em spec). */
export const cifraDeTeste = (k: Buffer) => ({
  encrypt(plain: string, aad?: string): EncryptedSecret {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', k, iv);
    if (aad !== undefined) c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64') };
  },
  decrypt(e: EncryptedSecret, aad?: string): string {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(e.iv, 'base64'));
    if (aad !== undefined) d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(e.authTag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]).toString('utf8');
  },
});
