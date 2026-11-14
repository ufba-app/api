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

// ---- projetos (etapa 7) ----

import {
  MemberRecord,
  MemoryProjectRepository,
  MemorySyncJobRepository,
  ProjectRecord,
  SyncJobRecord,
  TeamGrantSource,
} from '../../src/application/memory/project-ports';

export class InMemoryProjectRepo extends MemoryProjectRepository {
  projects = new Map<string, ProjectRecord>();
  members: MemberRecord[] = [];
  async insert(p: ProjectRecord) {
    if ([...this.projects.values()].some((x) => x.workspace === p.workspace && x.project === p.project)) return false;
    this.projects.set(p.id, { ...p });
    return true;
  }
  async find(id: string) {
    return this.projects.get(id) ?? null;
  }
  async findByCoordinates(workspace: string, project: string) {
    return [...this.projects.values()].find((x) => x.workspace === workspace && x.project === project) ?? null;
  }
  async listAll() {
    return [...this.projects.values()];
  }
  async listForUser(userId: string) {
    return [...this.projects.values()].filter(
      (p) => p.ownerId === userId || this.members.some((m) => m.projectId === p.id && m.userId === userId && m.status === 'active'),
    );
  }
  async listOwnedBy(userId: string) {
    return [...this.projects.values()].filter((p) => p.ownerId === userId);
  }
  async titleTakenBy(ownerId: string, title: string) {
    return [...this.projects.values()].some((p) => p.ownerId === ownerId && p.title.toLowerCase() === title.toLowerCase());
  }
  async delete(id: string) {
    this.projects.delete(id);
    this.members = this.members.filter((m) => m.projectId !== id);
  }
  async setOwner(id: string, ownerId: string) {
    this.projects.get(id)!.ownerId = ownerId;
  }
  async listMembers(projectId: string) {
    return this.members.filter((m) => m.projectId === projectId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async findMember(projectId: string, email: string) {
    return this.members.find((m) => m.projectId === projectId && m.email === email) ?? null;
  }
  async upsertMember(m: MemberRecord) {
    const i = this.members.findIndex((x) => x.projectId === m.projectId && x.email === m.email);
    if (i >= 0) this.members[i] = { ...this.members[i], userId: m.userId, level: m.level, status: m.status, invitedBy: m.invitedBy };
    else this.members.push({ ...m });
  }
  async deleteMember(projectId: string, email: string) {
    this.members = this.members.filter((m) => !(m.projectId === projectId && m.email === email));
  }
  async listMembershipsOf(userId: string) {
    return this.members.filter((m) => m.userId === userId);
  }
  async listPendingByEmail(email: string) {
    return this.members.filter((m) => m.email === email && m.status === 'pending');
  }
  async bindMember(projectId: string, email: string, userId: string) {
    const m = this.members.find((x) => x.projectId === projectId && x.email === email && x.status === 'pending');
    if (m) Object.assign(m, { userId, status: 'active' });
  }
  async listInvolvedUserIds() {
    return [
      ...new Set([
        ...[...this.projects.values()].map((p) => p.ownerId),
        ...this.members.filter((m) => m.status === 'active').map((m) => m.userId),
      ].filter((x): x is string => Boolean(x))),
    ];
  }
}

export class InMemorySyncJobRepo extends MemorySyncJobRepository {
  jobs = new Map<string, SyncJobRecord>();
  async schedule(userId: string, attempts: number, nextRunAt: Date, lastError: string | null) {
    this.jobs.set(userId, { userId, attempts, nextRunAt, lastError });
  }
  async clear(userId: string) {
    this.jobs.delete(userId);
  }
  async find(userId: string) {
    return this.jobs.get(userId) ?? null;
  }
  async listDue(now: Date, limit: number) {
    return [...this.jobs.values()].filter((j) => j.nextRunAt <= now).slice(0, limit);
  }
  async listAll(limit: number) {
    return [...this.jobs.values()].slice(0, limit);
  }
}

export class StubTeamGrants extends TeamGrantSource {
  grants = new Map<string, { projectId: string; level: 'read' | 'write' }[]>();
  async grantsFor(userId: string) {
    return this.grants.get(userId) ?? [];
  }
  async involvedUserIds() {
    return [...this.grants.keys()];
  }
}
