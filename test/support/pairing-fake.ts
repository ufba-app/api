import {
  SigaaPairingRepository,
  type SigaaPairingPacket,
  type SigaaPairingRecord,
} from '../../src/application/ports/repositories';

/** Pedidos do QR em memória (mesma semântica do repositório do Postgres). */
export class InMemoryPairings extends SigaaPairingRepository {
  readonly rows = new Map<string, SigaaPairingRecord>();

  async create(r: Omit<SigaaPairingRecord, 'packet'>) {
    this.rows.set(r.id, { ...r, packet: null });
  }
  async find(id: string, userId: string, now: Date) {
    const r = this.rows.get(id);
    return r && r.userId === userId && r.expiresAt > now ? r : null;
  }
  async deliver(id: string, userId: string, packet: SigaaPairingPacket, now: Date) {
    const r = await this.find(id, userId, now);
    if (!r || r.packet) return false;
    r.packet = packet;
    return true;
  }
  async take(id: string, userId: string, now: Date) {
    const r = await this.find(id, userId, now);
    if (!r?.packet) return null;
    this.rows.delete(id);
    return r.packet;
  }
  async countOpen(userId: string, now: Date) {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.expiresAt > now).length;
  }
  async deleteExpired(now: Date) {
    for (const [k, r] of this.rows) if (r.expiresAt <= now) this.rows.delete(k);
  }
}
