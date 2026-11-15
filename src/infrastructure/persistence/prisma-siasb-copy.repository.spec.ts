import { PrismaSiasbCopyRepository } from "./prisma-siasb-copy.repository";
import type { PrismaService } from "./prisma.service";

const U = "0192b3c4-0000-7000-8000-000000000001";
const secret = { ciphertext: "Y2lwaGVy", iv: "aXY=", authTag: "dGFn" };
const W = {
  from: new Date("2026-11-10T00:00:00Z"),
  to: new Date("2026-11-20T00:00:00Z"),
};
const session = {
  id: "s1",
  attendanceId: "a1",
  disciplineId: "d1",
  disciplineName: "Disciplina Teste",
  professorName: "Docente Teste",
  locationName: "Sala 1",
  startAt: new Date("2026-11-12T10:00:00Z"),
  endAt: new Date("2026-11-12T11:00:00Z"),
  rescheduledStartAt: null,
  statusLabel: "Agendada",
};

function setup() {
  const tx = {
    sourceAccount: { findFirst: jest.fn().mockResolvedValue({ id: "acc" }) },
    siasbSyncedAttendance: { deleteMany: jest.fn(), createMany: jest.fn() },
    siasbSyncedSession: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (t: typeof tx) => unknown)(tx),
    ),
    sourceAccount: { findMany: jest.fn() },
    siasbSyncedAttendance: { findMany: jest.fn(), deleteMany: jest.fn() },
    siasbSyncedSession: { findMany: jest.fn(), deleteMany: jest.fn() },
    siasbSyncState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  return {
    repo: new PrismaSiasbCopyRepository(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

describe("PrismaSiasbCopyRepository", () => {
  it("replaceWindow: uma única $transaction, apaga a janela e grava; atendimentos substituídos", async () => {
    const { repo, prisma, tx } = setup();
    const ok = await repo.replaceWindow(U, W, {
      attendances: [
        {
          id: "a1",
          disciplineId: "d1",
          disciplineName: "D",
          treatmentType: "TRIAGE",
          concluded: false,
          firstName: secret,
        },
      ],
      sessions: [session],
    });
    expect(ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.sourceAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: U, provider: "SIASB" } }),
    );
    expect(tx.siasbSyncedAttendance.deleteMany).toHaveBeenCalledWith({
      where: { userId: U },
    });
    expect(tx.siasbSyncedAttendance.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: U,
          id: "a1",
          firstNameCiphertext: "Y2lwaGVy",
          firstNameIv: "aXY=",
          firstNameAuthTag: "dGFn",
        }),
      ],
    });
    expect(tx.siasbSyncedSession.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: U,
        OR: [{ startAt: { gte: W.from, lte: W.to } }, { id: { in: ["s1"] } }],
      },
    });
    expect(tx.siasbSyncedSession.createMany).toHaveBeenCalledWith({
      data: [{ userId: U, ...session }],
    });
    // nada fora da transação
    expect(prisma.siasbSyncedSession.deleteMany).not.toHaveBeenCalled();
  });

  it("replaceWindow: false e nada gravado sem conta SIASB", async () => {
    const { repo, tx } = setup();
    tx.sourceAccount.findFirst.mockResolvedValue(null);
    await expect(
      repo.replaceWindow(U, W, { attendances: [], sessions: [session] }),
    ).resolves.toBe(false);
    expect(tx.siasbSyncedAttendance.deleteMany).not.toHaveBeenCalled();
    expect(tx.siasbSyncedSession.createMany).not.toHaveBeenCalled();
  });

  it("sessions: janela inclusiva, ordenada por startAt", async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncedSession.findMany.mockResolvedValue([
      { userId: U, ...session },
    ]);
    const out = await repo.sessions(U, W.from, W.to);
    expect(prisma.siasbSyncedSession.findMany).toHaveBeenCalledWith({
      where: { userId: U, startAt: { gte: W.from, lte: W.to } },
      orderBy: { startAt: "asc" },
    });
    expect(out).toEqual([session]);
  });

  it("attendances: remonta o segredo cifrado", async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncedAttendance.findMany.mockResolvedValue([
      {
        userId: U,
        id: "a1",
        disciplineId: "d1",
        disciplineName: "D",
        treatmentType: "URGENCY",
        concluded: true,
        firstNameCiphertext: "Y2lwaGVy",
        firstNameIv: "aXY=",
        firstNameAuthTag: "dGFn",
      },
    ]);
    expect(await repo.attendances(U)).toEqual([
      {
        id: "a1",
        disciplineId: "d1",
        disciplineName: "D",
        treatmentType: "URGENCY",
        concluded: true,
        firstName: secret,
      },
    ]);
  });

  it("state: devolve null sem linha e mapeia o resultado", async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncState.findUnique.mockResolvedValue(null);
    expect(await repo.state(U)).toBeNull();
    const at = new Date("2026-11-15T10:00:00Z");
    prisma.siasbSyncState.findUnique.mockResolvedValue({
      userId: U,
      lastAttemptAt: at,
      lastSuccessAt: at,
      result: "OK",
      nextRunAt: null,
      lockedUntil: at,
    });
    expect(await repo.state(U)).toEqual({
      lastAttemptAt: at,
      lastSuccessAt: at,
      result: "OK",
      nextRunAt: null,
    });
  });

  it("deleteAll apaga cópia e estado numa transação", async () => {
    const { repo, prisma } = setup();
    await repo.deleteAll(U);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.siasbSyncedSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: U },
    });
    expect(prisma.siasbSyncedAttendance.deleteMany).toHaveBeenCalledWith({
      where: { userId: U },
    });
    expect(prisma.siasbSyncState.deleteMany).toHaveBeenCalledWith({
      where: { userId: U },
    });
  });

  it("recordAttempt: lastSuccessAt só em OK", async () => {
    const { repo, prisma } = setup();
    const at = new Date("2026-11-15T10:00:00Z");
    await repo.recordAttempt(U, { result: "OK", at, nextRunAt: null });
    expect(prisma.siasbSyncState.upsert.mock.calls[0][0].update).toEqual({
      lastAttemptAt: at,
      result: "OK",
      nextRunAt: null,
      lastSuccessAt: at,
    });
    await repo.recordAttempt(U, { result: "UNAVAILABLE", at, nextRunAt: null });
    const last = prisma.siasbSyncState.upsert.mock.calls[1][0];
    expect(last.update).toEqual({
      lastAttemptAt: at,
      result: "UNAVAILABLE",
      nextRunAt: null,
    });
    expect(last.create).toEqual({
      userId: U,
      lastAttemptAt: at,
      result: "UNAVAILABLE",
      nextRunAt: null,
    });
  });

  it("claim: cria a linha se faltar e toma a trava com um UPDATE condicional", async () => {
    const { repo, prisma } = setup();
    const now = new Date("2026-11-15T12:00:00Z");
    prisma.siasbSyncState.updateMany.mockResolvedValue({ count: 1 });
    await expect(repo.claim(U, now, 60_000)).resolves.toBe(true);
    expect(prisma.siasbSyncState.createMany).toHaveBeenCalledWith({
      data: [{ userId: U }],
      skipDuplicates: true,
    });
    expect(prisma.siasbSyncState.updateMany).toHaveBeenCalledWith({
      where: {
        userId: U,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + 60_000) },
    });
    prisma.siasbSyncState.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.claim(U, now, 60_000)).resolves.toBe(false);
  });

  it("release limpa a trava", async () => {
    const { repo, prisma } = setup();
    await repo.release(U);
    expect(prisma.siasbSyncState.updateMany).toHaveBeenCalledWith({
      where: { userId: U },
      data: { lockedUntil: null },
    });
  });

  it("dueUsers: só conta OK; sem estado primeiro, depois nextRunAt crescente, até o limite", async () => {
    const { repo, prisma } = setup();
    const now = new Date("2026-11-15T12:00:00Z");
    const acc = (userId: string, st: object | null) => ({
      userId,
      user: { siasbSyncState: st },
    });
    prisma.sourceAccount.findMany.mockResolvedValue([
      acc("late", {
        nextRunAt: new Date("2026-11-15T11:00:00Z"),
        lastAttemptAt: now,
      }),
      acc("future", {
        nextRunAt: new Date("2026-11-15T13:00:00Z"),
        lastAttemptAt: now,
      }),
      acc("fresh", null),
      acc("early", {
        nextRunAt: new Date("2026-11-15T10:00:00Z"),
        lastAttemptAt: now,
      }),
      acc("stopped", { nextRunAt: null, lastAttemptAt: now }),
    ]);
    expect(await repo.dueUsers(now, 3)).toEqual(["fresh", "early", "late"]);
    expect(prisma.sourceAccount.findMany.mock.calls[0][0].where).toEqual({
      provider: "SIASB",
      status: "OK",
    });
  });
});
