import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  EntityType,
  StoredHash,
  SyncBatch,
  SyncCounts,
  SyncRepository,
  SyncRunRecord,
} from '../../application/ports/repositories';
import type {
  FetchedCourseSpace,
  FetchedEvent,
  FetchedGrade,
  FetchedItem,
} from '../../application/ports/source-gateway';
import { courseSpaceHash } from '../../application/sync/hashes';
import {
  eventKey,
  gradeKey,
  itemKey,
  splitKey,
} from '../../application/sync/keys';
import { PrismaService } from './prisma.service';

type Tx = Prisma.TransactionClient;
type ChangeRow = Prisma.ChangeEventCreateManyInput;
type Emit = (
  entityType: ChangeRow['entityType'],
  entityId: string,
  change: ChangeRow['change'],
  summary: string,
) => void;

const json = (v: unknown): Prisma.InputJsonValue | undefined =>
  v === undefined ? undefined : (v as Prisma.InputJsonValue);

@Injectable()
export class PrismaSyncRepository extends SyncRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async startRun(input: {
    sourceAccountId: string;
    scope: 'ALL' | 'COURSE' | 'ITEM';
    scopeRef?: string;
  }): Promise<SyncRunRecord> {
    const row = await this.prisma.syncRun.create({
      data: {
        sourceAccountId: input.sourceAccountId,
        scope: input.scope,
        scopeRef: input.scopeRef ?? null,
      },
    });
    return { id: row.id, startedAt: row.startedAt };
  }

  async finishRun(
    runId: string,
    result:
      | { ok: true; counts: SyncCounts }
      | { ok: false; errorCode: string; errorMessage: string },
  ): Promise<void> {
    await this.prisma.syncRun.update({
      where: { id: runId },
      data: result.ok
        ? {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            createdCount: result.counts.created,
            updatedCount: result.counts.updated,
            removedCount: result.counts.removed,
            unchangedCount: result.counts.unchanged,
          }
        : {
            status: 'FAILED',
            finishedAt: new Date(),
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          },
    });
  }

  async storedHashes(
    sourceAccountId: string,
    entity: EntityType,
    course?: string,
  ): Promise<StoredHash[]> {
    const live = { sourceAccountId, deletedAt: null };
    switch (entity) {
      case 'COURSE_SPACE': {
        const rows = await this.prisma.courseSpace.findMany({
          where: { ...live, ...(course ? { externalId: course } : {}) },
          select: { externalId: true, extra: true, name: true },
        });
        // CourseSpace não tem coluna de hash: ele é recalculado de (name, extra).
        return rows.map((r) => ({
          externalId: r.externalId,
          contentHash: courseSpaceHash({
            name: r.name,
            extra: (r.extra ?? undefined) as Record<string, unknown> | undefined,
          }),
        }));
      }
      case 'ITEM': {
        const rows = await this.prisma.item.findMany({
          where: {
            ...live,
            ...(course ? { courseSpace: { externalId: course } } : {}),
          },
          select: {
            externalId: true,
            kind: true,
            contentHash: true,
            courseSpace: { select: { externalId: true } },
          },
        });
        return rows.map((r) => ({
          externalId: itemKey({
            courseExternalId: r.courseSpace.externalId,
            kind: r.kind,
            externalId: r.externalId,
          }),
          contentHash: r.contentHash,
        }));
      }
      case 'GRADE_ENTRY': {
        const rows = await this.prisma.gradeEntry.findMany({
          where: {
            ...live,
            ...(course ? { courseSpace: { externalId: course } } : {}),
          },
          select: {
            externalId: true,
            contentHash: true,
            courseSpace: { select: { externalId: true } },
          },
        });
        return rows.map((r) => ({
          externalId: gradeKey({
            courseExternalId: r.courseSpace.externalId,
            externalId: r.externalId,
          }),
          contentHash: r.contentHash,
        }));
      }
      case 'CALENDAR_EVENT': {
        const rows = await this.prisma.calendarEvent.findMany({
          where: live,
          select: { calendarId: true, externalId: true, contentHash: true },
        });
        return rows.map((r) => ({
          externalId: eventKey(r),
          contentHash: r.contentHash,
        }));
      }
    }
  }

  async apply(input: {
    sourceAccountId: string;
    runId: string;
    courseSpaces?: SyncBatch<FetchedCourseSpace>;
    items?: SyncBatch<FetchedItem>;
    events?: SyncBatch<FetchedEvent>;
    grades?: SyncBatch<FetchedGrade>;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const acc = input.sourceAccountId;
      const changes: ChangeRow[] = [];
      const emit: Emit = (entityType, entityId, change, summary) => {
        changes.push({
          syncRunId: input.runId,
          sourceAccountId: acc,
          entityType,
          entityId,
          change,
          summary,
        });
      };

      if (input.courseSpaces) {
        await this.applyCourseSpaces(tx, acc, input.courseSpaces, emit);
      }
      const spaces = new Map(
        (
          await tx.courseSpace.findMany({
            where: { sourceAccountId: acc, deletedAt: null },
            select: { id: true, externalId: true },
          })
        ).map((s) => [s.externalId, s.id]),
      );
      if (input.items) {
        await this.applyItems(tx, acc, spaces, input.items, emit);
      }
      if (input.grades) {
        await this.applyGrades(tx, acc, spaces, input.grades, emit);
      }
      if (input.events) {
        await this.applyEvents(tx, acc, input.events, emit);
      }

      if (changes.length) await tx.changeEvent.createMany({ data: changes });
    });
  }

  private async applyCourseSpaces(
    tx: Tx,
    acc: string,
    batch: SyncBatch<FetchedCourseSpace>,
    emit: Emit,
  ): Promise<void> {
    const now = new Date();
    for (const [kind, rows] of [
      ['CREATED', batch.created],
      ['UPDATED', batch.updated],
    ] as const) {
      for (const { data } of rows) {
        const row = await tx.courseSpace.upsert({
          where: {
            sourceAccountId_externalId: {
              sourceAccountId: acc,
              externalId: data.externalId,
            },
          },
          create: {
            sourceAccountId: acc,
            externalId: data.externalId,
            name: data.name,
            extra: json(data.extra),
          },
          update: {
            name: data.name,
            extra: json(data.extra),
            lastSeenAt: now,
            deletedAt: null,
          },
        });
        emit('COURSE_SPACE', row.id, kind, data.name);
      }
    }
    for (const { data } of batch.unchanged) {
      await tx.courseSpace.updateMany({
        where: { sourceAccountId: acc, externalId: data.externalId },
        data: { lastSeenAt: now },
      });
    }
    if (batch.removed.length) {
      const rows = await tx.courseSpace.findMany({
        where: {
          sourceAccountId: acc,
          externalId: { in: batch.removed },
          deletedAt: null,
        },
      });
      await tx.courseSpace.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { deletedAt: now },
      });
      rows.forEach((r) => emit('COURSE_SPACE', r.id, 'REMOVED', r.name));
    }
  }

  private async applyItems(
    tx: Tx,
    acc: string,
    spaces: Map<string, string>,
    batch: SyncBatch<FetchedItem>,
    emit: Emit,
  ): Promise<void> {
    const now = new Date();
    for (const [kind, rows] of [
      ['CREATED', batch.created],
      ['UPDATED', batch.updated],
    ] as const) {
      for (const { data, hash } of rows) {
        const courseSpaceId = spaces.get(data.courseExternalId);
        if (!courseSpaceId) continue; // disciplina desconhecida: ignorado
        const fields = {
          title: data.title,
          body: data.body ?? null,
          dueAt: data.dueAt ?? null,
          publishedAt: data.publishedAt ?? null,
          state: data.state ?? null,
          extra: json(data.extra),
          contentHash: hash,
          lastSeenAt: now,
          deletedAt: null,
        };
        const row = await tx.item.upsert({
          where: {
            courseSpaceId_kind_externalId: {
              courseSpaceId,
              kind: data.kind,
              externalId: data.externalId,
            },
          },
          create: {
            courseSpaceId,
            sourceAccountId: acc,
            kind: data.kind,
            externalId: data.externalId,
            ...fields,
          },
          update: fields,
        });
        if (data.attachments) {
          await tx.attachment.deleteMany({ where: { itemId: row.id } });
          if (data.attachments.length) {
            await tx.attachment.createMany({
              data: data.attachments.map((a) => ({
                itemId: row.id,
                externalId: a.externalId ?? null,
                name: a.name,
                mimeType: a.mimeType ?? null,
                sizeBytes: a.sizeBytes ?? null,
                sourceUrl: a.sourceUrl ?? null,
              })),
            });
          }
        }
        emit('ITEM', row.id, kind, data.title);
      }
    }
    for (const { data } of batch.unchanged) {
      const courseSpaceId = spaces.get(data.courseExternalId);
      if (!courseSpaceId) continue;
      await tx.item.updateMany({
        where: { courseSpaceId, kind: data.kind, externalId: data.externalId },
        data: { lastSeenAt: now },
      });
    }
    for (const key of batch.removed) {
      const [course, kind, externalId] = splitKey(key, 3);
      const courseSpaceId = spaces.get(course);
      if (!courseSpaceId) continue;
      const row = await tx.item.findFirst({
        where: {
          courseSpaceId,
          kind: kind as FetchedItem['kind'],
          externalId,
          deletedAt: null,
        },
      });
      if (!row) continue;
      await tx.item.update({ where: { id: row.id }, data: { deletedAt: now } });
      emit('ITEM', row.id, 'REMOVED', row.title);
    }
  }

  private async applyGrades(
    tx: Tx,
    acc: string,
    spaces: Map<string, string>,
    batch: SyncBatch<FetchedGrade>,
    emit: Emit,
  ): Promise<void> {
    const now = new Date();
    for (const [kind, rows] of [
      ['CREATED', batch.created],
      ['UPDATED', batch.updated],
    ] as const) {
      for (const { data, hash } of rows) {
        const courseSpaceId = spaces.get(data.courseExternalId);
        if (!courseSpaceId) continue;
        const item = data.itemExternalId
          ? await tx.item.findFirst({
              where: { courseSpaceId, externalId: data.itemExternalId },
              select: { id: true },
            })
          : null;
        const fields = {
          label: data.label,
          score: data.score ?? null,
          maxScore: data.maxScore ?? null,
          weight: data.weight ?? null,
          gradedAt: data.gradedAt ?? null,
          itemId: item?.id ?? null,
          contentHash: hash,
          lastSeenAt: now,
          deletedAt: null,
        };
        const row = await tx.gradeEntry.upsert({
          where: {
            courseSpaceId_externalId: {
              courseSpaceId,
              externalId: data.externalId,
            },
          },
          create: {
            courseSpaceId,
            sourceAccountId: acc,
            externalId: data.externalId,
            ...fields,
          },
          update: fields,
        });
        emit('GRADE_ENTRY', row.id, kind, data.label);
      }
    }
    for (const { data } of batch.unchanged) {
      const courseSpaceId = spaces.get(data.courseExternalId);
      if (!courseSpaceId) continue;
      await tx.gradeEntry.updateMany({
        where: { courseSpaceId, externalId: data.externalId },
        data: { lastSeenAt: now },
      });
    }
    for (const key of batch.removed) {
      const [course, externalId] = splitKey(key, 2);
      const courseSpaceId = spaces.get(course);
      if (!courseSpaceId) continue;
      const row = await tx.gradeEntry.findFirst({
        where: { courseSpaceId, externalId, deletedAt: null },
      });
      if (!row) continue;
      await tx.gradeEntry.update({
        where: { id: row.id },
        data: { deletedAt: now },
      });
      emit('GRADE_ENTRY', row.id, 'REMOVED', row.label);
    }
  }

  private async applyEvents(
    tx: Tx,
    acc: string,
    batch: SyncBatch<FetchedEvent>,
    emit: Emit,
  ): Promise<void> {
    const now = new Date();
    for (const [kind, rows] of [
      ['CREATED', batch.created],
      ['UPDATED', batch.updated],
    ] as const) {
      for (const { data, hash } of rows) {
        const fields = {
          title: data.title,
          description: data.description ?? null,
          location: data.location ?? null,
          startsAt: data.startsAt,
          endsAt: data.endsAt ?? null,
          allDay: data.allDay ?? false,
          status: data.status ?? null,
          contentHash: hash,
          lastSeenAt: now,
          deletedAt: null,
        };
        const row = await tx.calendarEvent.upsert({
          where: {
            sourceAccountId_calendarId_externalId: {
              sourceAccountId: acc,
              calendarId: data.calendarId,
              externalId: data.externalId,
            },
          },
          create: {
            sourceAccountId: acc,
            calendarId: data.calendarId,
            externalId: data.externalId,
            ...fields,
          },
          update: fields,
        });
        emit('CALENDAR_EVENT', row.id, kind, data.title);
      }
    }
    for (const { data } of batch.unchanged) {
      await tx.calendarEvent.updateMany({
        where: {
          sourceAccountId: acc,
          calendarId: data.calendarId,
          externalId: data.externalId,
        },
        data: { lastSeenAt: now },
      });
    }
    for (const key of batch.removed) {
      const [calendarId, externalId] = splitKey(key, 2);
      const row = await tx.calendarEvent.findFirst({
        where: { sourceAccountId: acc, calendarId, externalId, deletedAt: null },
      });
      if (!row) continue;
      await tx.calendarEvent.update({
        where: { id: row.id },
        data: { deletedAt: now },
      });
      emit('CALENDAR_EVENT', row.id, 'REMOVED', row.title);
    }
  }
}
