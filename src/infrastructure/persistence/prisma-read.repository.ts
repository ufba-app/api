import { Injectable } from '@nestjs/common';
import {
  ChangeView,
  CourseSpaceView,
  EventView,
  ItemFilter,
  ItemView,
  ProfileView,
  ReadRepository,
} from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

/** Só consulta o banco. Tudo é filtrado pelo dono (via SourceAccount.userId). */
@Injectable()
export class PrismaReadRepository extends ReadRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listCourseSpaces(userId: string): Promise<CourseSpaceView[]> {
    const rows = await this.prisma.courseSpace.findMany({
      where: { deletedAt: null, sourceAccount: { userId } },
      include: { sourceAccount: { select: { provider: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.sourceAccount.provider,
      externalId: r.externalId,
      name: r.name,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async listItems(f: ItemFilter): Promise<ItemView[]> {
    const due =
      f.dueFrom || f.dueTo
        ? { dueAt: { gte: f.dueFrom, lte: f.dueTo } }
        : {};
    const rows = await this.prisma.item.findMany({
      where: {
        deletedAt: null,
        sourceAccount: {
          userId: f.userId,
          ...(f.provider ? { provider: f.provider } : {}),
        },
        ...(f.courseSpaceId ? { courseSpaceId: f.courseSpaceId } : {}),
        ...(f.kind ? { kind: f.kind } : {}),
        ...due,
      },
      include: {
        courseSpace: { select: { name: true } },
        attachments: { select: { id: true, name: true, mimeType: true, sizeBytes: true } },
        sourceAccount: { select: { provider: true } },
      },
      orderBy: [{ dueAt: 'asc' }, { publishedAt: 'desc' }],
      take: Math.min(f.limit ?? 100, 500),
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.sourceAccount.provider,
      courseSpaceId: r.courseSpaceId,
      courseName: r.courseSpace.name,
      kind: r.kind,
      title: r.title,
      body: r.body,
      dueAt: r.dueAt,
      publishedAt: r.publishedAt,
      state: r.state,
      attachments: r.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes),
      })),
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async listEvents(input: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<EventView[]> {
    const rows = await this.prisma.calendarEvent.findMany({
      where: {
        deletedAt: null,
        sourceAccount: { userId: input.userId },
        startsAt: { gte: input.from, lte: input.to },
      },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      location: r.location,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      allDay: r.allDay,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async listChanges(input: {
    userId: string;
    since: Date;
    limit?: number;
  }): Promise<ChangeView[]> {
    const rows = await this.prisma.changeEvent.findMany({
      where: {
        occurredAt: { gt: input.since },
        sourceAccount: { userId: input.userId },
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(input.limit ?? 100, 500),
    });
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      change: r.change,
      summary: r.summary,
      occurredAt: r.occurredAt,
    }));
  }

  async getProfile(userId: string): Promise<ProfileView | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, sourceAccounts: true },
    });
    if (!user) return null;
    return {
      name: user.name,
      registration: user.profile?.registration ?? null,
      programName: user.profile?.programName ?? null,
      entryTerm: user.profile?.entryTerm ?? null,
      accounts: user.sourceAccounts.map((a) => ({
        provider: a.provider,
        status: a.status,
        lastSyncedAt: a.lastSyncedAt,
      })),
    };
  }

  async getTranscript(
    userId: string,
  ): Promise<{ importedAt: Date; data: unknown } | null> {
    const t = await this.prisma.transcript.findUnique({
      where: { userId },
      include: { entries: true, pending: true },
    });
    if (!t) return null;
    const { fetchedAt, ...data } = t;
    return { importedAt: fetchedAt, data };
  }
}
