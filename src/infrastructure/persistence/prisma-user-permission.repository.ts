import { Injectable } from '@nestjs/common';
import { UserPermissionRepository } from '../../application/ports/permissions';
import { PrismaService } from './prisma.service';

/** Interruptores por pessoa (`user_permissions`). Só chave e valor; `DELETE /me` apaga tudo por cascade. */
@Injectable()
export class PrismaUserPermissionRepository extends UserPermissionRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(userId: string) {
    const rows = await this.prisma.userPermission.findMany({ where: { userId } });
    return rows.map((r) => ({ key: r.key, enabled: r.enabled }));
  }

  async set(userId: string, key: string, enabled: boolean, at: Date) {
    await this.prisma.userPermission.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, enabled, updatedAt: at },
      update: { enabled, updatedAt: at },
    });
  }

  async deleteBySource(userId: string, source: string) {
    await this.prisma.userPermission.deleteMany({ where: { userId, key: { startsWith: `${source}.` } } });
  }
}
