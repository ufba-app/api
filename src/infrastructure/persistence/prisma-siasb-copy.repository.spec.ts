import { PrismaSiasbCopyRepository } from './prisma-siasb-copy.repository';
import type { PrismaService } from './prisma.service';

const U = '0192b3c4-0000-7000-8000-000000000001';
const secret = { ciphertext: 'Y2lwaGVy', iv: 'aXY=', authTag: 'dGFn' };
const W = {
  from: new Date('2026-11-10T00:00:00Z'),
  to: new Date('2026-11-20T00:00:00Z'),
};
const session = {
  id: 's1',
  attendanceId: 'a1',
  disciplineId: 'd1',
  disciplineName: 'Disciplina Teste',
  professorName: 'Docente Teste',
  locationName: 'Sala 1',
  startAt: new Date('2026-11-12T10:00:00Z'),
  endAt: new Date('2026-11-12T11:00:00Z'),
  rescheduledStartAt: null,
  statusLabel: 'Agendada',
};

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'acc' }]),
    siasbSyncedDiscipline: { deleteMany: jest.fn(), createMany: jest.fn() },
    siasbSyncedAttendance: { deleteMany: jest.fn(), createMany: jest.fn() },
    siasbSyncedSession: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (t: typeof tx) => unknown)(tx),
    ),
    sourceAccount: { findMany: jest.fn() },
    siasbSyncedDiscipline: { findMany: jest.fn(), deleteMany: jest.fn() },
    siasbSyncedAttendance: { findMany: jest.fn(), deleteMany: jest.fn() },
    siasbSyncedSession: { findMany: jest.fn(), deleteMany: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
    siasbSyncState: {
      findUnique: jest.fn(),
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

describe('PrismaSiasbCopyRepository', () => {
  it('replaceWindow: uma única $transaction, apaga a janela e grava; atendimentos substituídos', async () => {
    const { repo, prisma, tx } = setup();
    const ok = await repo.replaceWindow(U, W, {
      disciplines: [{ id: 'd1', name: 'Disciplina Teste' }],
      attendances: [
        {
          id: 'a1',
          disciplineId: 'd1',
          disciplineName: 'D',
          treatmentType: 'TRIAGE',
          concluded: false,
          active: true,
          firstName: secret,
        },
      ],
      sessions: [session],
    });
    expect(ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // trava de linha da conta SIASB, no cliente da transação e antes de qualquer escrita
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('FROM source_accounts');
    expect(sql).toContain("provider = 'SIASB'");
    expect(sql).toContain('FOR SHARE');
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(U);
    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(tx.siasbSyncedDiscipline.deleteMany.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(tx.siasbSyncedAttendance.deleteMany.mock.invocationCallOrder[0]);
    expect(tx.siasbSyncedDiscipline.deleteMany).toHaveBeenCalledWith({ where: { userId: U } });
    expect(tx.siasbSyncedDiscipline.createMany).toHaveBeenCalledWith({
      data: [{ userId: U, id: 'd1', name: 'Disciplina Teste' }],
    });
    expect(lockOrder).toBeLessThan(tx.siasbSyncedSession.deleteMany.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(tx.siasbSyncedSession.createMany.mock.invocationCallOrder[0]);
    expect(tx.siasbSyncedAttendance.deleteMany).toHaveBeenCalledWith({
      where: { userId: U },
    });
    expect(tx.siasbSyncedAttendance.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: U,
          id: 'a1',
          concluded: false,
          active: true,
          firstNameCiphertext: 'Y2lwaGVy',
          firstNameIv: 'aXY=',
          firstNameAuthTag: 'dGFn',
        }),
      ],
    });
    expect(tx.siasbSyncedSession.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: U,
        OR: [{ startAt: { gte: W.from, lte: W.to } }, { id: { in: ['s1'] } }],
      },
    });
    expect(tx.siasbSyncedSession.createMany).toHaveBeenCalledWith({
      data: [{ userId: U, ...session }],
    });
    // nada fora da transação
    expect(prisma.siasbSyncedSession.deleteMany).not.toHaveBeenCalled();
  });

  it('replaceWindow: false e nada gravado sem conta SIASB', async () => {
    const { repo, tx } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(repo.replaceWindow(U, W, { disciplines: [], attendances: [], sessions: [session] })).resolves.toBe(false);
    expect(tx.siasbSyncedDiscipline.deleteMany).not.toHaveBeenCalled();
    expect(tx.siasbSyncedAttendance.deleteMany).not.toHaveBeenCalled();
    expect(tx.siasbSyncedSession.createMany).not.toHaveBeenCalled();
  });

  it('disciplines: ordenadas por nome e sem campos do banco', async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncedDiscipline.findMany.mockResolvedValue([{ userId: U, id: 'd1', name: 'Alfa' }]);
    expect(await repo.disciplines(U)).toEqual([{ id: 'd1', name: 'Alfa' }]);
    expect(prisma.siasbSyncedDiscipline.findMany).toHaveBeenCalledWith({
      where: { userId: U },
      orderBy: { name: 'asc' },
    });
  });

  it('sessions: janela inclusiva, ordenada por startAt', async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncedSession.findMany.mockResolvedValue([{ userId: U, ...session }]);
    const out = await repo.sessions(U, W.from, W.to);
    expect(prisma.siasbSyncedSession.findMany).toHaveBeenCalledWith({
      where: { userId: U, startAt: { gte: W.from, lte: W.to } },
      orderBy: { startAt: 'asc' },
    });
    expect(out).toEqual([session]);
  });

  it('attendances: remonta o segredo cifrado', async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncedAttendance.findMany.mockResolvedValue([
      {
        userId: U,
        id: 'a1',
        disciplineId: 'd1',
        disciplineName: 'D',
        treatmentType: 'URGENCY',
        concluded: true,
        active: false,
        firstNameCiphertext: 'Y2lwaGVy',
        firstNameIv: 'aXY=',
        firstNameAuthTag: 'dGFn',
      },
    ]);
    expect(await repo.attendances(U)).toEqual([
      {
        id: 'a1',
        disciplineId: 'd1',
        disciplineName: 'D',
        treatmentType: 'URGENCY',
        concluded: true,
        active: false,
        firstName: secret,
      },
    ]);
  });

  it('state: devolve null sem linha e mapeia o resultado', async () => {
    const { repo, prisma } = setup();
    prisma.siasbSyncState.findUnique.mockResolvedValue(null);
    expect(await repo.state(U)).toBeNull();
    const at = new Date('2026-11-15T10:00:00Z');
    prisma.siasbSyncState.findUnique.mockResolvedValue({
      userId: U,
      lastAttemptAt: at,
      lastSuccessAt: at,
      result: 'OK',
      nextRunAt: null,
      lockedUntil: at,
    });
    expect(await repo.state(U)).toEqual({
      lastAttemptAt: at,
      lastSuccessAt: at,
      result: 'OK',
      nextRunAt: null,
    });
  });

  it('deleteAll apaga cópia e estado numa transação', async () => {
    const { repo, prisma } = setup();
    await repo.deleteAll(U);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.siasbSyncedDiscipline.deleteMany).toHaveBeenCalledWith({ where: { userId: U } });
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

  it('recordAttempt: updateMany (sem upsert, sem recriar linha órfã); lastSuccessAt só em OK', async () => {
    const { repo, prisma } = setup();
    const at = new Date('2026-11-15T10:00:00Z');
    await repo.recordAttempt(U, { result: 'OK', at, nextRunAt: null });
    expect(prisma.siasbSyncState.updateMany.mock.calls[0][0]).toEqual({
      where: { userId: U },
      data: { lastAttemptAt: at, result: 'OK', nextRunAt: null, lastSuccessAt: at },
    });
    await repo.recordAttempt(U, { result: 'UNAVAILABLE', at, nextRunAt: null });
    expect(prisma.siasbSyncState.updateMany.mock.calls[1][0]).toEqual({
      where: { userId: U },
      data: { lastAttemptAt: at, result: 'UNAVAILABLE', nextRunAt: null },
    });
  });

  it('claim: INSERT só com conta SIASB (EXISTS) e depois UPDATE condicional da trava', async () => {
    const { repo, prisma } = setup();
    const now = new Date('2026-11-15T12:00:00Z');
    prisma.siasbSyncState.updateMany.mockResolvedValue({ count: 1 });
    await expect(repo.claim(U, now, 60_000)).resolves.toBe('claimed');
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('INSERT INTO siasb_sync_state');
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM source_accounts WHERE user_id = ?::uuid AND provider = 'SIASB')");
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(values).toEqual([U, U]);
    expect(prisma.siasbSyncState.updateMany).toHaveBeenCalledWith({
      where: {
        userId: U,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + 60_000) },
    });
  });

  it('claim: trava válida com linha existente é busy; sem linha (sem conta) é no_account', async () => {
    const { repo, prisma } = setup();
    const now = new Date('2026-11-15T12:00:00Z');
    prisma.siasbSyncState.updateMany.mockResolvedValue({ count: 0 });
    prisma.siasbSyncState.findUnique.mockResolvedValue({ userId: U });
    await expect(repo.claim(U, now, 60_000)).resolves.toBe('busy');
    prisma.siasbSyncState.findUnique.mockResolvedValue(null);
    await expect(repo.claim(U, now, 60_000)).resolves.toBe('no_account');
  });

  it('release limpa a trava', async () => {
    const { repo, prisma } = setup();
    await repo.release(U);
    expect(prisma.siasbSyncState.updateMany).toHaveBeenCalledWith({
      where: { userId: U },
      data: { lockedUntil: null },
    });
  });

  it('dueUsers: só conta OK; sem estado primeiro, depois nextRunAt crescente, até o limite', async () => {
    const { repo, prisma } = setup();
    const now = new Date('2026-11-15T12:00:00Z');
    const acc = (userId: string, st: object | null) => ({
      userId,
      user: { siasbSyncState: st },
    });
    prisma.sourceAccount.findMany.mockResolvedValue([
      acc('late', {
        nextRunAt: new Date('2026-11-15T11:00:00Z'),
        lastAttemptAt: now,
      }),
      acc('future', {
        nextRunAt: new Date('2026-11-15T13:00:00Z'),
        lastAttemptAt: now,
      }),
      acc('fresh', null),
      acc('early', {
        nextRunAt: new Date('2026-11-15T10:00:00Z'),
        lastAttemptAt: now,
      }),
      acc('stopped', { nextRunAt: null, lastAttemptAt: now }),
    ]);
    expect(await repo.dueUsers(now, 4)).toEqual(['fresh', 'stopped', 'early', 'late']);
    expect(prisma.sourceAccount.findMany.mock.calls[0][0].where).toEqual({
      provider: 'SIASB',
      status: 'OK',
    });
  });

  it("connectedUsers: ids distintos de contas SIASB em qualquer estado", async () => {
    const { repo, prisma } = setup();
    prisma.sourceAccount.findMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    expect(await repo.connectedUsers()).toEqual(["a", "b"]);
    expect(prisma.sourceAccount.findMany).toHaveBeenCalledWith({
      where: { provider: "SIASB" },
      select: { userId: true },
      distinct: ["userId"],
    });
  });
});
