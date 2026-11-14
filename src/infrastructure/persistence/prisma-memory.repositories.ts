import { Injectable } from '@nestjs/common';
import { MemoryUserRecord, MemoryUserRepository } from '../../application/memory/memory-ports';
import type { EncryptedSecret } from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

type Row = {
  userId: string;
  memoryUsername: string;
  status: string;
  proxyCredentialId: string | null;
  proxyKeyCiphertext: string | null;
  proxyKeyIv: string | null;
  proxyKeyAuthTag: string | null;
  displayName: string | null;
};

function toRecord(row: Row): MemoryUserRecord {
  const proxyKey: EncryptedSecret | null =
    row.proxyKeyCiphertext && row.proxyKeyIv && row.proxyKeyAuthTag
      ? { ciphertext: row.proxyKeyCiphertext, iv: row.proxyKeyIv, authTag: row.proxyKeyAuthTag }
      : null;
  return {
    userId: row.userId,
    memoryUsername: row.memoryUsername,
    status: row.status as MemoryUserRecord['status'],
    proxyCredentialId: row.proxyCredentialId,
    proxyKey,
    displayName: row.displayName,
  };
}

@Injectable()
export class PrismaMemoryUserRepository extends MemoryUserRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async find(userId: string): Promise<MemoryUserRecord | null> {
    const row = await this.prisma.memoryUser.findUnique({ where: { userId } });
    return row ? toRecord(row) : null;
  }

  async createIfAbsent(input: { userId: string; memoryUsername: string }): Promise<MemoryUserRecord> {
    const row = await this.prisma.memoryUser.upsert({
      where: { userId: input.userId },
      update: {},
      create: { userId: input.userId, memoryUsername: input.memoryUsername, status: 'creating' },
    });
    return toRecord(row);
  }

  async saveProxyIfAbsent(
    userId: string,
    input: { credentialId: string; key: EncryptedSecret; displayName: string | null },
  ): Promise<boolean> {
    // Atualização condicional (proxyCredentialId nulo): só uma chamada simultânea ganha.
    const { count } = await this.prisma.memoryUser.updateMany({
      where: { userId, proxyCredentialId: null },
      data: {
        proxyCredentialId: input.credentialId,
        proxyKeyCiphertext: input.key.ciphertext,
        proxyKeyIv: input.key.iv,
        proxyKeyAuthTag: input.key.authTag,
        displayName: input.displayName,
      },
    });
    return count === 1;
  }

  async markReady(userId: string): Promise<void> {
    await this.prisma.memoryUser.updateMany({ where: { userId, status: 'creating' }, data: { status: 'ready' } });
  }
}
