import { Injectable } from '@nestjs/common';
import {
  SiasbCopyRepository,
  type SyncedAttendance,
  type SyncedSession,
  type SyncResult,
  type SyncState,
} from '../../application/ports/siasb-copy';
import { PrismaService } from './prisma.service';

/** Cópia por aluno do SIASB (`siasb_attendances`, `siasb_sessions`, `siasb_sync_state`). `DELETE /me` apaga por cascade. */
@Injectable()
export class PrismaSiasbCopyRepository extends SiasbCopyRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async replaceWindow(
    userId: string,
    window: { from: Date; to: Date },
    data: { attendances: SyncedAttendance[]; sessions: SyncedSession[] },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // FOR SHARE trava a linha da conta até o commit: uma desconexão concorrente (DELETE da conta) espera esta
      // transação e o `deleteAll` dela, que vem depois, apaga o que gravamos aqui. Sem a trava, o DELETE poderia
      // commitar entre a checagem e as gravações e deixar cópia órfã (nunca mais sincronizada nem apagada).
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM source_accounts WHERE user_id = ${userId}::uuid AND provider = 'SIASB' FOR SHARE`;
      if (locked.length === 0) return false;
      await tx.siasbSyncedAttendance.deleteMany({ where: { userId } });
      if (data.attendances.length) {
        await tx.siasbSyncedAttendance.createMany({
          data: data.attendances.map((a) => ({
            userId,
            id: a.id,
            disciplineId: a.disciplineId,
            disciplineName: a.disciplineName,
            treatmentType: a.treatmentType,
            concluded: a.concluded,
            firstNameCiphertext: a.firstName.ciphertext,
            firstNameIv: a.firstName.iv,
            firstNameAuthTag: a.firstName.authTag,
          })),
        });
      }
      await tx.siasbSyncedSession.deleteMany({
        where: {
          userId,
          OR: [{ startAt: { gte: window.from, lte: window.to } }, { id: { in: data.sessions.map((s) => s.id) } }],
        },
      });
      if (data.sessions.length) {
        await tx.siasbSyncedSession.createMany({
          data: data.sessions.map((s) => ({ userId, ...s })),
        });
      }
      return true;
    });
  }

  async sessions(userId: string, from: Date, to: Date): Promise<SyncedSession[]> {
    const rows = await this.prisma.siasbSyncedSession.findMany({
      where: { userId, startAt: { gte: from, lte: to } },
      orderBy: { startAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      attendanceId: r.attendanceId,
      disciplineId: r.disciplineId,
      disciplineName: r.disciplineName,
      professorName: r.professorName,
      locationName: r.locationName,
      startAt: r.startAt,
      endAt: r.endAt,
      rescheduledStartAt: r.rescheduledStartAt,
      statusLabel: r.statusLabel,
    }));
  }

  async attendances(userId: string): Promise<SyncedAttendance[]> {
    const rows = await this.prisma.siasbSyncedAttendance.findMany({
      where: { userId },
    });
    return rows.map((r) => ({
      id: r.id,
      disciplineId: r.disciplineId,
      disciplineName: r.disciplineName,
      treatmentType: r.treatmentType as SyncedAttendance['treatmentType'],
      concluded: r.concluded,
      firstName: {
        ciphertext: r.firstNameCiphertext,
        iv: r.firstNameIv,
        authTag: r.firstNameAuthTag,
      },
    }));
  }

  async deleteAll(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.siasbSyncedSession.deleteMany({ where: { userId } }),
      this.prisma.siasbSyncedAttendance.deleteMany({ where: { userId } }),
      this.prisma.siasbSyncState.deleteMany({ where: { userId } }),
    ]);
  }

  async state(userId: string): Promise<SyncState | null> {
    const r = await this.prisma.siasbSyncState.findUnique({
      where: { userId },
    });
    if (!r) return null;
    return {
      lastAttemptAt: r.lastAttemptAt,
      lastSuccessAt: r.lastSuccessAt,
      result: r.result as SyncResult | null,
      nextRunAt: r.nextRunAt,
    };
  }

  async recordAttempt(userId: string, r: { result: SyncResult; at: Date; nextRunAt: Date | null }): Promise<void> {
    const base = {
      lastAttemptAt: r.at,
      result: r.result,
      nextRunAt: r.nextRunAt,
    };
    const success = r.result === 'OK' ? { lastSuccessAt: r.at } : {};
    await this.prisma.siasbSyncState.upsert({
      where: { userId },
      create: { userId, ...base, ...success },
      update: { ...base, ...success },
    });
  }

  async claim(userId: string, now: Date, leaseMs: number): Promise<boolean> {
    // cria a linha se faltar (sem sobrescrever) e toma a trava num único UPDATE condicional (atômico no Postgres)
    await this.prisma.siasbSyncState.createMany({
      data: [{ userId }],
      skipDuplicates: true,
    });
    const { count } = await this.prisma.siasbSyncState.updateMany({
      where: {
        userId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + leaseMs) },
    });
    return count === 1;
  }

  async release(userId: string): Promise<void> {
    await this.prisma.siasbSyncState.updateMany({
      where: { userId },
      data: { lockedUntil: null },
    });
  }

  async dueUsers(now: Date, limit: number): Promise<string[]> {
    // poucas contas SIASB: filtra e ordena em memória em vez de um SQL com junção e NULLS FIRST
    const accounts = await this.prisma.sourceAccount.findMany({
      where: { provider: 'SIASB', status: 'OK' },
      select: {
        userId: true,
        user: {
          select: {
            siasbSyncState: {
              select: { nextRunAt: true, lastAttemptAt: true },
            },
          },
        },
      },
    });
    const due: { userId: string; at: number }[] = [];
    for (const a of accounts) {
      const s = a.user.siasbSyncState;
      // Sem agenda (nextRunAt nulo) é devido: a conta está OK, então a pessoa reconectou depois de RECONNECT_REQUIRED.
      if (!s || !s.nextRunAt) due.push({ userId: a.userId, at: -Infinity });
      else if (s.nextRunAt <= now) due.push({ userId: a.userId, at: s.nextRunAt.getTime() });
    }
    return due
      .sort((x, y) => x.at - y.at)
      .slice(0, limit)
      .map((d) => d.userId);
  }
}
