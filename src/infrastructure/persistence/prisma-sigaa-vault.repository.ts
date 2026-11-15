import { Injectable } from '@nestjs/common';
import { SigaaVaultRepository, type EncryptedSecret, type SigaaVaultRecord } from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

/** Cofre da senha do SIGAA no Postgres (`sigaa_vaults`). Só guarda a senha cifrada com a DK; nada vai para log. */
@Injectable()
export class PrismaSigaaVaultRepository extends SigaaVaultRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async find(userId: string): Promise<SigaaVaultRecord | null> {
    const r = await this.prisma.sigaaVault.findUnique({ where: { userId } });
    if (!r) return null;
    return {
      userId: r.userId,
      login: r.login,
      secret: { ciphertext: r.secretCiphertext, iv: r.secretIv, authTag: r.secretAuthTag },
      status: r.status === 'REAUTH_NEEDED' ? 'REAUTH_NEEDED' : 'OK',
      version: r.version,
      updatedAt: r.updatedAt,
    };
  }

  async upsert(i: { userId: string; login: string; secret: EncryptedSecret }): Promise<void> {
    const cols = {
      login: i.login,
      secretCiphertext: i.secret.ciphertext,
      secretIv: i.secret.iv,
      secretAuthTag: i.secret.authTag,
      status: 'OK' as const,
    };
    await this.prisma.sigaaVault.upsert({
      where: { userId: i.userId },
      create: { userId: i.userId, ...cols },
      update: { ...cols, version: { increment: 1 } },
    });
  }

  async setStatus(userId: string, status: 'OK' | 'REAUTH_NEEDED'): Promise<void> {
    await this.prisma.sigaaVault.updateMany({ where: { userId }, data: { status } });
  }

  async delete(userId: string): Promise<void> {
    await this.prisma.sigaaVault.deleteMany({ where: { userId } });
  }
}
