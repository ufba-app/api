import {
  DeviceAuthorizationRecord,
  DeviceAuthorizationRepository,
  MemoryComputerDirectory,
  MemoryComputerRecord,
  MemoryComputerRepository,
} from '../../src/application/memory/device-ports';
import { MemoryUserRecord, MemoryUserRepository } from '../../src/application/memory/memory-ports';
import type { EncryptedSecret } from '../../src/application/ports/repositories';

export class InMemoryUserRepo extends MemoryUserRepository {
  rows = new Map<string, MemoryUserRecord>();
  async find(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async createIfAbsent(i: { userId: string; memoryUsername: string }) {
    const cur = this.rows.get(i.userId);
    if (cur) return cur;
    const row: MemoryUserRecord = {
      userId: i.userId,
      memoryUsername: i.memoryUsername,
      status: 'creating',
      proxyCredentialId: null,
      proxyKey: null,
      displayName: null,
    };
    this.rows.set(i.userId, row);
    return row;
  }
  async saveProxyIfAbsent(userId: string, i: { credentialId: string; key: EncryptedSecret; displayName: string | null }) {
    const row = this.rows.get(userId)!;
    if (row.proxyCredentialId) return false;
    Object.assign(row, { proxyCredentialId: i.credentialId, proxyKey: i.key, displayName: i.displayName });
    return true;
  }
  async markReady(userId: string) {
    this.rows.get(userId)!.status = 'ready';
  }
}

export class InMemoryDeviceRepo extends DeviceAuthorizationRepository {
  rows = new Map<string, DeviceAuthorizationRecord>();
  async create(rec: DeviceAuthorizationRecord) {
    if ([...this.rows.values()].some((r) => r.userCodeHash === rec.userCodeHash)) return false;
    this.rows.set(rec.deviceCodeHash, { ...rec });
    return true;
  }
  async findByDeviceHash(h: string) {
    return this.rows.get(h) ?? null;
  }
  async findByUserHash(h: string) {
    return [...this.rows.values()].find((r) => r.userCodeHash === h) ?? null;
  }
  async findByTokenHash(h: string) {
    return [...this.rows.values()].find((r) => r.tokenHash === h) ?? null;
  }
  async countActiveByIp(ip: string, now: Date) {
    return [...this.rows.values()].filter(
      (r) => r.requestIp === ip && r.expiresAt > now && (r.status === 'pending' || r.status === 'approved'),
    ).length;
  }
  async touchPoll(h: string, v: { lastPolledAt: Date; intervalSec: number; pollCount: number }) {
    Object.assign(this.rows.get(h)!, v);
  }
  async decide(userHash: string, userId: string, status: 'approved' | 'denied', now: Date) {
    const r = [...this.rows.values()].find((x) => x.userCodeHash === userHash);
    if (!r || r.status !== 'pending' || r.expiresAt <= now) return false;
    Object.assign(r, { status, userId });
    return true;
  }
  async issueToken(h: string, tokenHash: string, tokenExpiresAt: Date, now: Date) {
    const r = this.rows.get(h);
    if (!r || r.status !== 'approved' || r.expiresAt <= now) return false;
    Object.assign(r, { status: 'issued', tokenHash, tokenExpiresAt });
    return true;
  }
  async consume(h: string, now: Date) {
    const r = this.rows.get(h);
    if (!r || r.status !== 'issued' || !r.tokenExpiresAt || r.tokenExpiresAt <= now) return false;
    r.status = 'consumed';
    return true;
  }
  async deleteExpired(before: Date) {
    for (const [k, r] of this.rows) if (r.expiresAt < before) this.rows.delete(k);
  }
}

export class InMemoryComputerRepo extends MemoryComputerRepository {
  rows = new Map<string, MemoryComputerRecord>();
  async insert(rec: MemoryComputerRecord) {
    this.rows.set(rec.id, { ...rec });
  }
  async find(id: string) {
    return this.rows.get(id) ?? null;
  }
  async listForUser(userId: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async countActive(userId: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId && !r.revokedAt).length;
  }
  async reissue(id: string, v: { credentialId: string; keyPreview: string | null; name: string; os: string; agents: string[]; clientVersion: string | null; installMode: string | null; at: Date }) {
    const { at, ...rest } = v;
    Object.assign(this.rows.get(id)!, { ...rest, confirmedAt: null, createdAt: at });
  }
  async confirm(id: string, userId: string, at: Date) {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId || r.revokedAt) return false;
    r.confirmedAt = at;
    return true;
  }
  async rename(id: string, userId: string, name: string) {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId) return false;
    r.name = name;
    return true;
  }
  async markRevoked(id: string, at: Date) {
    const r = this.rows.get(id);
    if (r && !r.revokedAt) r.revokedAt = at;
  }
  async listUnconfirmed(before: Date, userId?: string) {
    return [...this.rows.values()].filter(
      (r) => !r.confirmedAt && !r.revokedAt && r.createdAt < before && (!userId || r.userId === userId),
    );
  }
}

/** Sem computadores (para testes do proxy que não se importam com eles). */
export class NoComputers extends MemoryComputerDirectory {
  async active() {
    return [];
  }
}
