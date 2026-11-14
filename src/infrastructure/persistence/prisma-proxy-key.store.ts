import { Injectable } from '@nestjs/common';
import type { EncryptedSecret } from '../../application/ports/repositories';
import { ProxyKeyStore } from '../../application/memory/proxy-key-rotation';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaProxyKeyStore extends ProxyKeyStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async replace(userId: string, key: EncryptedSecret, at: Date): Promise<void> {
    await this.prisma.memoryUser.update({
      where: { userId },
      data: {
        proxyKeyCiphertext: key.ciphertext,
        proxyKeyIv: key.iv,
        proxyKeyAuthTag: key.authTag,
        proxyKeyRotatedAt: at,
      },
    });
  }

  async reset(userId: string): Promise<void> {
    await this.prisma.memoryUser.updateMany({
      where: { userId },
      data: {
        status: 'creating',
        proxyCredentialId: null,
        proxyKeyCiphertext: null,
        proxyKeyIv: null,
        proxyKeyAuthTag: null,
      },
    });
  }

  async listStale(before: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.memoryUser.findMany({
      where: {
        status: 'ready',
        proxyCredentialId: { not: null },
        OR: [{ proxyKeyRotatedAt: { lt: before } }, { proxyKeyRotatedAt: null, createdAt: { lt: before } }],
      },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => r.userId);
  }
}
