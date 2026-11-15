import { Injectable } from '@nestjs/common';
import {
  SigaaPairingRepository,
  type SigaaPairingPacket,
  type SigaaPairingRecord,
} from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

/** Pedidos do QR no Postgres (`sigaa_pairings`). Nada daqui vai para log; o pacote é opaco para o servidor. */
@Injectable()
export class PrismaSigaaPairingRepository extends SigaaPairingRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(r: Omit<SigaaPairingRecord, 'packet'>) {
    await this.prisma.sigaaPairing.create({
      data: { id: r.id, userId: r.userId, label: r.label, client: r.client, createdAt: r.createdAt, expiresAt: r.expiresAt },
    });
  }

  async find(id: string, userId: string, now: Date): Promise<SigaaPairingRecord | null> {
    const r = await this.prisma.sigaaPairing.findFirst({ where: { id, userId, expiresAt: { gt: now } } });
    if (!r) return null;
    return {
      id: r.id,
      userId: r.userId,
      label: r.label,
      client: r.client,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      packet: r.pub && r.iv && r.ciphertext ? { pub: r.pub, iv: r.iv, ciphertext: r.ciphertext } : null,
    };
  }

  async deliver(id: string, userId: string, p: SigaaPairingPacket, now: Date) {
    // Uma única escrita condicional: só entrega quem encontra o pedido aberto, do dono, ainda sem pacote.
    const r = await this.prisma.sigaaPairing.updateMany({
      where: { id, userId, expiresAt: { gt: now }, deliveredAt: null },
      data: { pub: p.pub, iv: p.iv, ciphertext: p.ciphertext, deliveredAt: now },
    });
    return r.count === 1;
  }

  async take(id: string, userId: string, now: Date): Promise<SigaaPairingPacket | null> {
    const r = await this.prisma.sigaaPairing.findFirst({
      where: { id, userId, expiresAt: { gt: now }, deliveredAt: { not: null } },
    });
    if (!r?.pub || !r.iv || !r.ciphertext) return null;
    // Quem apaga primeiro leva o pacote; uma segunda leitura encontra count 0.
    const gone = await this.prisma.sigaaPairing.deleteMany({ where: { id, userId } });
    return gone.count === 1 ? { pub: r.pub, iv: r.iv, ciphertext: r.ciphertext } : null;
  }

  countOpen(userId: string, now: Date) {
    return this.prisma.sigaaPairing.count({ where: { userId, expiresAt: { gt: now } } });
  }

  async deleteExpired(now: Date) {
    await this.prisma.sigaaPairing.deleteMany({ where: { expiresAt: { lte: now } } });
  }
}
