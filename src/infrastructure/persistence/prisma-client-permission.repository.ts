import { Injectable } from '@nestjs/common';
import { ClientPermissionRepository } from '../../application/ports/permissions';
import { PrismaService } from './prisma.service';

/** Permissões por app (`client_permissions`). Só a chave; `DELETE /me` apaga tudo por cascade. */
@Injectable()
export class PrismaClientPermissionRepository extends ClientPermissionRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async keysOf(userId: string, clientId: string) {
    const rows = await this.prisma.clientPermission.findMany({ where: { userId, clientId }, select: { key: true } });
    return rows.map((r) => r.key);
  }

  async listByUser(userId: string) {
    const rows = await this.prisma.clientPermission.findMany({ where: { userId }, select: { clientId: true, key: true } });
    return rows.map((r) => ({ clientId: r.clientId, key: r.key }));
  }

  async replace(userId: string, clientId: string, keys: readonly string[], at: Date) {
    await this.prisma.$transaction([
      this.prisma.clientPermission.deleteMany({ where: { userId, clientId } }),
      this.prisma.clientPermission.createMany({ data: keys.map((key) => ({ userId, clientId, key, grantedAt: at })) }),
    ]);
  }

  async revoke(userId: string, clientId: string, key: string) {
    const r = await this.prisma.clientPermission.deleteMany({ where: { userId, clientId, key } });
    return r.count > 0;
  }

  async revokeEverywhere(userId: string, key: string) {
    await this.prisma.clientPermission.deleteMany({ where: { userId, key } });
  }

  async deleteClient(userId: string, clientId: string) {
    await this.prisma.clientPermission.deleteMany({ where: { userId, clientId } });
  }

  async deleteBySource(userId: string, source: string) {
    await this.prisma.clientPermission.deleteMany({ where: { userId, key: { startsWith: `${source}.` } } });
  }
}
