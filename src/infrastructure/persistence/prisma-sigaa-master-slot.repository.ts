import { Injectable } from '@nestjs/common';
import { SigaaMasterSlotRepository, type SigaaMasterSlotRecord } from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

const toRecord = (r: SigaaMasterSlotRecord): SigaaMasterSlotRecord => ({
  credentialId: r.credentialId,
  prfSalt: r.prfSalt,
  iv: r.iv,
  ciphertext: r.ciphertext,
  label: r.label,
  createdAt: r.createdAt,
  lastUnlockedAt: r.lastUnlockedAt,
});

/** Cópias mestras no Postgres (tabela `sigaa_master_slots`). Nunca loga nem devolve os bytes fora do repositório. */
@Injectable()
export class PrismaSigaaMasterSlotRepository extends SigaaMasterSlotRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(userId: string) {
    return (await this.prisma.sigaaMasterSlot.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(toRecord);
  }

  count(userId: string) {
    return this.prisma.sigaaMasterSlot.count({ where: { userId } });
  }

  async find(userId: string, credentialId: string) {
    const r = await this.prisma.sigaaMasterSlot.findUnique({ where: { userId_credentialId: { userId, credentialId } } });
    return r ? toRecord(r) : null;
  }

  async upsert(userId: string, s: Omit<SigaaMasterSlotRecord, 'createdAt' | 'lastUnlockedAt'>) {
    const data = { prfSalt: s.prfSalt, iv: s.iv, ciphertext: s.ciphertext, label: s.label };
    await this.prisma.sigaaMasterSlot.upsert({
      where: { userId_credentialId: { userId, credentialId: s.credentialId } },
      create: { userId, credentialId: s.credentialId, ...data },
      update: { ...data, lastUnlockedAt: null },
    });
  }

  async touch(userId: string, credentialId: string, at: Date) {
    await this.prisma.sigaaMasterSlot.updateMany({ where: { userId, credentialId }, data: { lastUnlockedAt: at } });
  }

  async delete(userId: string, credentialId: string) {
    return (await this.prisma.sigaaMasterSlot.deleteMany({ where: { userId, credentialId } })).count > 0;
  }

  async deleteAll(userId: string) {
    await this.prisma.sigaaMasterSlot.deleteMany({ where: { userId } });
  }
}
