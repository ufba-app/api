import { Injectable } from '@nestjs/common';
import { GrantLevel } from '../../application/memory/memory-ports';
import { TeamRoleRecord, TeamRoleRepository, UserLister } from '../../application/memory/team-ports';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaTeamRoleRepository extends TeamRoleRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listRoles(): Promise<TeamRoleRecord[]> {
    const rows = await this.prisma.teamRole.findMany({ include: { grants: true }, orderBy: { key: 'asc' } });
    return rows.map((r) => ({
      key: r.key,
      description: r.description,
      grants: r.grants.map((g) => ({ projectId: g.projectId, level: g.level as GrantLevel })),
    }));
  }

  async rolesOf(userId: string): Promise<string[]> {
    return (await this.prisma.userTeamRole.findMany({ where: { userId }, select: { roleKey: true } })).map((r) => r.roleKey);
  }

  listAssignments(): Promise<{ userId: string; roleKey: string }[]> {
    return this.prisma.userTeamRole.findMany({ select: { userId: true, roleKey: true } });
  }

  async assign(userId: string, roleKey: string, assignedBy: string): Promise<void> {
    await this.prisma.userTeamRole.upsert({
      where: { userId_roleKey: { userId, roleKey } },
      create: { userId, roleKey, assignedBy },
      update: {},
    });
  }

  async unassign(userId: string, roleKey: string): Promise<boolean> {
    const { count } = await this.prisma.userTeamRole.deleteMany({ where: { userId, roleKey } });
    return count === 1;
  }
}

@Injectable()
export class PrismaUserLister extends UserLister {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  search(query: string, limit: number) {
    return this.prisma.user.findMany({
      where: {
        email: { not: null },
        OR: [{ name: { contains: query, mode: 'insensitive' } }, { email: { contains: query, mode: 'insensitive' } }],
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      take: limit,
    });
  }

  byIds(ids: string[]) {
    return this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  }

  list(limit: number) {
    return this.prisma.user.findMany({
      where: { email: { not: null } },
      select: { id: true, name: true, email: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
