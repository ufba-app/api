import { randomUUID } from 'node:crypto';
import type { SyncedAttendance, SyncedDiscipline, SyncedSession } from '../../application/ports/siasb-copy';
import { PrismaSiasbCopyRepository } from './prisma-siasb-copy.repository';
import { PrismaService } from './prisma.service';

/**
 * Integração contra um Postgres de verdade. Roda SÓ no CI (Postgres efêmero, migrado por `npm run prisma:deploy`) com
 * `RUN_DB_TESTS=1`. NUNCA rode contra um banco compartilhado. Cada teste cria o próprio usuário (valores sintéticos) e
 * apaga só o que criou (o cascade leva o resto).
 */
const maybe = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const WINDOW = { from: new Date(NOW.getTime() - 10 * DAY), to: new Date(NOW.getTime() + 10 * DAY) };
const WIDE = { from: new Date(NOW.getTime() - 400 * DAY), to: new Date(NOW.getTime() + 400 * DAY) };

function discipline(id: string, name = `Disciplina ${id}`): SyncedDiscipline {
  return { id, name };
}

function attendance(id: string): SyncedAttendance {
  return {
    id,
    disciplineId: 'D1',
    disciplineName: 'Disciplina sintética',
    treatmentType: 'TRIAGE',
    concluded: false,
    firstName: { ciphertext: 'ct', iv: 'iv', authTag: 'tag' },
  };
}

function session(id: string, startAt: Date): SyncedSession {
  return {
    id,
    attendanceId: 'a1',
    disciplineId: 'D1',
    disciplineName: 'Disciplina sintética',
    professorName: 'Professor sintético',
    locationName: 'Sala sintética',
    startAt,
    endAt: new Date(startAt.getTime() + 60 * 60 * 1000),
    rescheduledStartAt: null,
    statusLabel: 'Agendada',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

maybe('PrismaSiasbCopyRepository (Postgres real)', () => {
  let prisma: PrismaService;
  let repo: PrismaSiasbCopyRepository;
  const created: string[] = [];

  async function makeUser(): Promise<string> {
    const id = randomUUID();
    await prisma.user.create({ data: { id, email: `int-${id}@example.invalid` } });
    created.push(id);
    return id;
  }

  async function makeAccount(userId: string, status: 'OK' | 'REAUTH_NEEDED' = 'OK'): Promise<void> {
    await prisma.sourceAccount.create({
      data: { userId, provider: 'SIASB', accountKey: 'siasb', status },
    });
  }

  async function counts(userId: string) {
    return {
      disciplines: await prisma.siasbSyncedDiscipline.count({ where: { userId } }),
      attendances: await prisma.siasbSyncedAttendance.count({ where: { userId } }),
      sessions: await prisma.siasbSyncedSession.count({ where: { userId } }),
      state: await prisma.siasbSyncState.count({ where: { userId } }),
    };
  }

  beforeAll(() => {
    prisma = new PrismaService();
    repo = new PrismaSiasbCopyRepository(prisma);
  });

  afterEach(async () => {
    const ids = created.splice(0);
    if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('replaceWindow', () => {
    it('grava, depois substitui as sessões da janela, mantém a de fora e troca todos os atendimentos', async () => {
      const userId = await makeUser();
      await makeAccount(userId);
      const outside = session('s-outside', new Date(NOW.getTime() - 100 * DAY));
      const inA = session('s-in-a', new Date(NOW.getTime() - 2 * DAY));
      const inB = session('s-in-b', new Date(NOW.getTime() + 2 * DAY));

      expect(
        await repo.replaceWindow(userId, WINDOW, { disciplines: [], attendances: [attendance('a1'), attendance('a2')], sessions: [outside, inA] }),
      ).toBe(true);
      expect((await repo.attendances(userId)).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
      expect((await repo.sessions(userId, WIDE.from, WIDE.to)).map((s) => s.id)).toEqual(['s-outside', 's-in-a']);

      expect(await repo.replaceWindow(userId, WINDOW, { disciplines: [], attendances: [attendance('a3')], sessions: [inB] })).toBe(true);
      expect((await repo.attendances(userId)).map((a) => a.id)).toEqual(['a3']);
      expect((await repo.sessions(userId, WIDE.from, WIDE.to)).map((s) => s.id)).toEqual(['s-outside', 's-in-b']);
    });

    it('grava as disciplinas (inclusive sem atendimento) e a próxima gravação as substitui todas', async () => {
      const userId = await makeUser();
      await makeAccount(userId);

      expect(
        await repo.replaceWindow(userId, WINDOW, {
          disciplines: [discipline('D2', 'Zeta'), discipline('D1', 'Alfa'), discipline('D3', 'Meio')],
          attendances: [attendance('a1')],
          sessions: [],
        }),
      ).toBe(true);
      expect(await repo.disciplines(userId)).toEqual([
        { id: 'D1', name: 'Alfa' },
        { id: 'D3', name: 'Meio' },
        { id: 'D2', name: 'Zeta' },
      ]);

      expect(
        await repo.replaceWindow(userId, WINDOW, { disciplines: [discipline('D3', 'Meio')], attendances: [], sessions: [] }),
      ).toBe(true);
      expect(await repo.disciplines(userId)).toEqual([{ id: 'D3', name: 'Meio' }]);
    });

    it('disciplina duplicada estoura e a transação desfaz tudo (as disciplinas que havia ficam)', async () => {
      const userId = await makeUser();
      await makeAccount(userId);
      await repo.replaceWindow(userId, WINDOW, { disciplines: [discipline('keep')], attendances: [], sessions: [] });

      await expect(
        repo.replaceWindow(userId, WINDOW, {
          disciplines: [discipline('dup'), discipline('dup')],
          attendances: [],
          sessions: [],
        }),
      ).rejects.toBeDefined();

      expect((await repo.disciplines(userId)).map((d) => d.id)).toEqual(['keep']);
    });

    it('sem conta SIASB devolve false e não grava nada', async () => {
      const userId = await makeUser();
      const ok = await repo.replaceWindow(userId, WINDOW, {
        disciplines: [discipline('D1')],
        attendances: [attendance('a1')],
        sessions: [session('s1', NOW)],
      });
      expect(ok).toBe(false);
      expect(await counts(userId)).toEqual({ disciplines: 0, attendances: 0, sessions: 0, state: 0 });
    });

    it('espera uma transação que apaga a conta (FOR SHARE), depois devolve false e não deixa nada', async () => {
      const userId = await makeUser();
      await makeAccount(userId);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markDeleted!: () => void;
      const deleted = new Promise<void>((resolve) => {
        markDeleted = resolve;
      });
      const deleter = prisma.$transaction(
        async (tx) => {
          await tx.sourceAccount.deleteMany({ where: { userId } });
          markDeleted();
          await gate;
        },
        { timeout: 15000 },
      );
      await deleted;

      let settled = false;
      const writer = repo
        .replaceWindow(userId, WINDOW, { disciplines: [discipline('D1')], attendances: [attendance('a1')], sessions: [session('s1', NOW)] })
        .finally(() => {
          settled = true;
        });
      await sleep(400);
      expect(settled).toBe(false);

      release();
      const [, result] = await Promise.all([deleter, writer]);
      expect(result).toBe(false);
      expect(await counts(userId)).toEqual({ disciplines: 0, attendances: 0, sessions: 0, state: 0 });
    });

    it('ids repetidos na mesma chamada estouram e a transação desfaz tudo (o que havia fica)', async () => {
      const userId = await makeUser();
      await makeAccount(userId);
      await repo.replaceWindow(userId, WINDOW, { disciplines: [], attendances: [attendance('keep')], sessions: [session('s-keep', NOW)] });

      await expect(
        repo.replaceWindow(userId, WINDOW, {
          disciplines: [],
          attendances: [attendance('dup'), attendance('dup')],
          sessions: [session('s-new', NOW)],
        }),
      ).rejects.toBeDefined();

      expect((await repo.attendances(userId)).map((a) => a.id)).toEqual(['keep']);
      expect((await repo.sessions(userId, WIDE.from, WIDE.to)).map((s) => s.id)).toEqual(['s-keep']);
    });
  });

  describe('claim, release e recordAttempt', () => {
    it('sem conta devolve no_account e não cria linha de estado', async () => {
      const userId = await makeUser();
      expect(await repo.claim(userId, NOW, 60_000)).toBe('no_account');
      expect((await counts(userId)).state).toBe(0);
    });

    it('com conta toma a trava; busy enquanto vale; de novo após o vencimento e após release', async () => {
      const userId = await makeUser();
      await makeAccount(userId);

      expect(await repo.claim(userId, NOW, 60_000)).toBe('claimed');
      expect((await counts(userId)).state).toBe(1);
      expect(await repo.claim(userId, new Date(NOW.getTime() + 30_000), 60_000)).toBe('busy');
      expect(await repo.claim(userId, new Date(NOW.getTime() + 120_000), 60_000)).toBe('claimed');

      expect(await repo.claim(userId, new Date(NOW.getTime() + 130_000), 60_000)).toBe('busy');
      await repo.release(userId);
      expect(await repo.claim(userId, new Date(NOW.getTime() + 131_000), 60_000)).toBe('claimed');
    });

    it('recordAttempt sem linha de estado não faz nada', async () => {
      const userId = await makeUser();
      await makeAccount(userId);
      await repo.recordAttempt(userId, { result: 'OK', at: NOW, nextRunAt: NOW });
      expect((await counts(userId)).state).toBe(0);
      expect(await repo.state(userId)).toBeNull();
    });

    it('recordAttempt grava resultado e agenda; lastSuccessAt só em OK', async () => {
      const userId = await makeUser();
      await makeAccount(userId);
      await repo.claim(userId, NOW, 60_000);

      const next = new Date(NOW.getTime() + 15 * 60_000);
      await repo.recordAttempt(userId, { result: 'UNAVAILABLE', at: NOW, nextRunAt: next });
      expect(await repo.state(userId)).toEqual({
        lastAttemptAt: NOW,
        lastSuccessAt: null,
        result: 'UNAVAILABLE',
        nextRunAt: next,
      });

      const later = new Date(NOW.getTime() + 60_000);
      const next2 = new Date(NOW.getTime() + 45 * 60_000);
      await repo.recordAttempt(userId, { result: 'OK', at: later, nextRunAt: next2 });
      expect(await repo.state(userId)).toEqual({
        lastAttemptAt: later,
        lastSuccessAt: later,
        result: 'OK',
        nextRunAt: next2,
      });

      const failAt = new Date(NOW.getTime() + 120_000);
      await repo.recordAttempt(userId, { result: 'RECONNECT_REQUIRED', at: failAt, nextRunAt: null });
      expect(await repo.state(userId)).toEqual({
        lastAttemptAt: failAt,
        lastSuccessAt: later,
        result: 'RECONNECT_REQUIRED',
        nextRunAt: null,
      });
    });
  });

  describe('dueUsers', () => {
    const BIG = 100_000;

    it('inclui sem estado, sem agenda e vencido; exclui agendado no futuro e conta REAUTH_NEEDED', async () => {
      const noState = await makeUser();
      await makeAccount(noState);

      const noSchedule = await makeUser();
      await makeAccount(noSchedule);
      await repo.claim(noSchedule, NOW, 60_000);

      const reconnected = await makeUser();
      await makeAccount(reconnected);
      await repo.claim(reconnected, NOW, 60_000);
      await repo.recordAttempt(reconnected, { result: 'RECONNECT_REQUIRED', at: NOW, nextRunAt: null });

      const overdue = await makeUser();
      await makeAccount(overdue);
      await repo.claim(overdue, NOW, 60_000);
      await repo.recordAttempt(overdue, { result: 'OK', at: NOW, nextRunAt: new Date(NOW.getTime() - 1000) });

      const exactlyNow = await makeUser();
      await makeAccount(exactlyNow);
      await repo.claim(exactlyNow, NOW, 60_000);
      await repo.recordAttempt(exactlyNow, { result: 'OK', at: NOW, nextRunAt: NOW });

      const future = await makeUser();
      await makeAccount(future);
      await repo.claim(future, NOW, 60_000);
      await repo.recordAttempt(future, { result: 'OK', at: NOW, nextRunAt: new Date(NOW.getTime() + 1000) });

      const reauth = await makeUser();
      await makeAccount(reauth, 'REAUTH_NEEDED');

      const due = await repo.dueUsers(NOW, BIG);
      for (const id of [noState, noSchedule, reconnected, overdue, exactlyNow]) expect(due).toContain(id);
      for (const id of [future, reauth]) expect(due).not.toContain(id);
    });

    it('respeita o limit', async () => {
      for (let i = 0; i < 3; i++) await makeAccount(await makeUser());
      const due = await repo.dueUsers(NOW, 2);
      expect(due.length).toBeLessThanOrEqual(2);
    });
  });

  describe('deleteAll e cascade', () => {
    async function fill(userId: string) {
      await makeAccount(userId);
      await repo.claim(userId, NOW, 60_000);
      await repo.replaceWindow(userId, WINDOW, {
        disciplines: [discipline('D1')],
        attendances: [attendance('a1')],
        sessions: [session('s1', NOW)],
      });
    }

    it('deleteAll apaga cópia e estado da pessoa e preserva a de outra', async () => {
      const a = await makeUser();
      const b = await makeUser();
      await fill(a);
      await fill(b);
      expect(await counts(a)).toEqual({ disciplines: 1, attendances: 1, sessions: 1, state: 1 });

      await repo.deleteAll(a);

      expect(await counts(a)).toEqual({ disciplines: 0, attendances: 0, sessions: 0, state: 0 });
      expect(await counts(b)).toEqual({ disciplines: 1, attendances: 1, sessions: 1, state: 1 });
    });

    it('apagar o usuário remove a cópia por cascade', async () => {
      const userId = await makeUser();
      await fill(userId);
      expect(await counts(userId)).toEqual({ disciplines: 1, attendances: 1, sessions: 1, state: 1 });

      await prisma.user.delete({ where: { id: userId } });

      expect(await counts(userId)).toEqual({ disciplines: 0, attendances: 0, sessions: 0, state: 0 });
    });
  });
});
