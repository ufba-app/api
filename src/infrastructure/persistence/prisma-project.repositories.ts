import { Injectable } from '@nestjs/common';
import { GrantLevel } from '../../application/memory/memory-ports';
import {
  MemberRecord,
  MemberStatus,
  MemoryProjectRepository,
  MemorySyncJobRepository,
  ProjectRecord,
  SyncJobRecord,
} from '../../application/memory/project-ports';
import { PrismaService } from './prisma.service';

type MemberRow = Omit<MemberRecord, 'level' | 'status'> & { level: string; status: string };
const toMember = (r: MemberRow): MemberRecord => ({
  ...r,
  level: r.level as GrantLevel,
  status: r.status as MemberStatus,
});

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';

@Injectable()
export class PrismaMemoryProjectRepository extends MemoryProjectRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async insert(p: ProjectRecord): Promise<boolean> {
    try {
      await this.prisma.memoryProject.create({ data: p });
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  find(id: string): Promise<ProjectRecord | null> {
    return this.prisma.memoryProject.findUnique({ where: { id } });
  }

  findByCoordinates(workspace: string, project: string): Promise<ProjectRecord | null> {
    return this.prisma.memoryProject.findUnique({ where: { workspace_project: { workspace, project } } });
  }

  listAll(): Promise<ProjectRecord[]> {
    return this.prisma.memoryProject.findMany({ orderBy: { createdAt: 'asc' } });
  }

  listForUser(userId: string): Promise<ProjectRecord[]> {
    return this.prisma.memoryProject.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId, status: 'active' } } }] },
      orderBy: { createdAt: 'asc' },
    });
  }

  listOwnedBy(userId: string): Promise<ProjectRecord[]> {
    return this.prisma.memoryProject.findMany({ where: { ownerId: userId } });
  }

  async titleTakenBy(ownerId: string, title: string): Promise<boolean> {
    return (
      (await this.prisma.memoryProject.count({ where: { ownerId, title: { equals: title, mode: 'insensitive' } } })) > 0
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.memoryProject.deleteMany({ where: { id } });
  }

  async setOwner(id: string, ownerId: string): Promise<void> {
    await this.prisma.memoryProject.update({ where: { id }, data: { ownerId } });
  }

  async listMembers(projectId: string): Promise<MemberRecord[]> {
    return (await this.prisma.memoryProjectMember.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })).map(toMember);
  }

  async findMember(projectId: string, email: string): Promise<MemberRecord | null> {
    const r = await this.prisma.memoryProjectMember.findUnique({ where: { projectId_email: { projectId, email } } });
    return r ? toMember(r) : null;
  }

  async upsertMember(m: MemberRecord): Promise<void> {
    const { projectId, email, ...data } = m;
    await this.prisma.memoryProjectMember.upsert({
      where: { projectId_email: { projectId, email } },
      create: m,
      update: { userId: data.userId, level: data.level, status: data.status, invitedBy: data.invitedBy },
    });
  }

  async deleteMember(projectId: string, email: string): Promise<void> {
    await this.prisma.memoryProjectMember.deleteMany({ where: { projectId, email } });
  }

  async listMembershipsOf(userId: string): Promise<MemberRecord[]> {
    return (await this.prisma.memoryProjectMember.findMany({ where: { userId } })).map(toMember);
  }

  async listPendingByEmail(email: string): Promise<MemberRecord[]> {
    return (await this.prisma.memoryProjectMember.findMany({ where: { email, status: 'pending' } })).map(toMember);
  }

  async bindMember(projectId: string, email: string, userId: string): Promise<void> {
    await this.prisma.memoryProjectMember.updateMany({
      where: { projectId, email, status: 'pending' },
      data: { userId, status: 'active' },
    });
  }

  async listInvolvedUserIds(): Promise<string[]> {
    const [owners, members] = await Promise.all([
      this.prisma.memoryProject.findMany({ where: { ownerId: { not: null } }, select: { ownerId: true }, distinct: ['ownerId'] }),
      this.prisma.memoryProjectMember.findMany({ where: { userId: { not: null }, status: 'active' }, select: { userId: true }, distinct: ['userId'] }),
    ]);
    return [...new Set([...owners.map((o) => o.ownerId), ...members.map((m) => m.userId)].filter((x): x is string => Boolean(x)))];
  }
}

@Injectable()
export class PrismaMemorySyncJobRepository extends MemorySyncJobRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async schedule(userId: string, attempts: number, nextRunAt: Date, lastError: string | null): Promise<void> {
    await this.prisma.memorySyncJob.upsert({
      where: { userId },
      create: { userId, attempts, nextRunAt, lastError },
      update: { attempts, nextRunAt, lastError },
    });
  }

  async clear(userId: string): Promise<void> {
    await this.prisma.memorySyncJob.deleteMany({ where: { userId } });
  }

  find(userId: string): Promise<SyncJobRecord | null> {
    return this.prisma.memorySyncJob.findUnique({ where: { userId } });
  }

  listDue(now: Date, limit: number): Promise<SyncJobRecord[]> {
    return this.prisma.memorySyncJob.findMany({ where: { nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: limit });
  }

  listAll(limit: number): Promise<SyncJobRecord[]> {
    return this.prisma.memorySyncJob.findMany({ orderBy: { nextRunAt: 'asc' }, take: limit });
  }
}
