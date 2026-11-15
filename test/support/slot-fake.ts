import { SigaaMasterSlotRepository, type SigaaMasterSlotRecord } from '../../src/application/ports/repositories';

/** Cópias mestras em memória (mesma semântica do repositório do Postgres). */
export class InMemorySlots extends SigaaMasterSlotRepository {
  readonly rows = new Map<string, SigaaMasterSlotRecord & { userId: string }>();
  private key = (u: string, c: string) => `${u}|${c}`;

  async list(userId: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async count(userId: string) {
    return (await this.list(userId)).length;
  }
  async find(userId: string, credentialId: string) {
    return this.rows.get(this.key(userId, credentialId)) ?? null;
  }
  async upsert(userId: string, s: Omit<SigaaMasterSlotRecord, 'createdAt' | 'lastUnlockedAt'>) {
    const old = this.rows.get(this.key(userId, s.credentialId));
    this.rows.set(this.key(userId, s.credentialId), { ...s, userId, createdAt: old?.createdAt ?? new Date(), lastUnlockedAt: null });
  }
  async touch(userId: string, credentialId: string, at: Date) {
    const r = this.rows.get(this.key(userId, credentialId));
    if (r) r.lastUnlockedAt = at;
  }
  async delete(userId: string, credentialId: string) {
    return this.rows.delete(this.key(userId, credentialId));
  }
  async deleteAll(userId: string) {
    for (const [k, r] of this.rows) if (r.userId === userId) this.rows.delete(k);
  }
}
