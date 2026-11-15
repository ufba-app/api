import { runSiasbJob, SYNC_MAX_USERS_PER_RUN, SYNC_SPACING_MS } from './siasb-job';
import type { SyncOutcome } from './siasb-syncer';

function setup(ids: string[], outcomes: Record<string, SyncOutcome | Error> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  const dueUsers = jest.fn(async (_now: Date, _limit: number) => ids);
  const syncUser = jest.fn(async (id: string) => {
    calls.push(id);
    events.push(`sync:${id}`);
    const o = outcomes[id] ?? 'OK';
    if (o instanceof Error) throw o;
    return o;
  });
  const sleep = jest.fn(async (ms: number) => {
    sleeps.push(ms);
    events.push('sleep');
  });
  const now = () => new Date('2026-11-15T12:00:00Z');
  return { calls, sleeps, events, dueUsers, syncUser, sleep, now };
}

describe('runSiasbJob', () => {
  let out: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    out = [];
    const grab = (...a: unknown[]) => void out.push(a.map(String).join(' '));
    logSpy = jest.spyOn(console, 'log').mockImplementation(grab);
    errSpy = jest.spyOn(console, 'error').mockImplementation(grab);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true));
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true));
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('processa só quem dueUsers devolve, na ordem, passando o limite', async () => {
    const s = setup(['u-a', 'u-b', 'u-c']);
    const code = await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    expect(code).toBe(0);
    expect(s.calls).toEqual(['u-a', 'u-b', 'u-c']);
    expect(s.dueUsers).toHaveBeenCalledWith(s.now(), SYNC_MAX_USERS_PER_RUN);
    expect(SYNC_MAX_USERS_PER_RUN).toBe(200);
    expect(SYNC_SPACING_MS).toBe(1500);
  });

  it('dorme entre pessoas, não depois da última', async () => {
    const s = setup(['u-a', 'u-b', 'u-c']);
    await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    expect(s.events).toEqual(['sync:u-a', 'sleep', 'sync:u-b', 'sleep', 'sync:u-c']);
    expect(s.sleeps).toEqual([1500, 1500]);
  });

  it('sem ninguém devido: não sincroniza nem dorme, código 0', async () => {
    const s = setup([]);
    const code = await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    expect(code).toBe(0);
    expect(s.syncUser).not.toHaveBeenCalled();
    expect(s.sleep).not.toHaveBeenCalled();
  });

  it('um syncUser que lança não interrompe os demais; código 0', async () => {
    const s = setup(['u-a', 'u-b', 'u-c'], {
      'u-b': new Error('paciente Fulano de Tal'),
    });
    const code = await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    expect(code).toBe(0);
    expect(s.calls).toEqual(['u-a', 'u-b', 'u-c']);
    expect(out.join('\n')).not.toContain('Fulano');
  });

  it('dueUsers lançando devolve 1', async () => {
    const s = setup([]);
    s.dueUsers.mockRejectedValueOnce(new Error('db caiu com segredo-xyz'));
    const code = await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    expect(code).toBe(1);
    expect(s.syncUser).not.toHaveBeenCalled();
    expect(out.join('\n')).not.toContain('segredo-xyz');
  });

  it('loga só contagens (inclui DISCONNECTED) e nenhum id de usuário', async () => {
    const s = setup(['user-id-111', 'user-id-222', 'user-id-333', 'user-id-444', 'user-id-555', 'user-id-666'], {
      'user-id-222': 'RECONNECT_REQUIRED',
      'user-id-333': 'UNAVAILABLE',
      'user-id-444': 'BUSY',
      'user-id-555': 'DISCONNECTED',
      'user-id-666': new Error('x'),
    });
    await runSiasbJob({
      syncer: { syncUser: s.syncUser },
      copy: { dueUsers: s.dueUsers },
      now: s.now,
      sleep: s.sleep,
    });
    const text = out.join('\n');
    expect(text).not.toMatch(/user-id/);
    expect(text).toContain('6');
    expect(text).toMatch(/ok/);
    expect(text).toMatch(/reconnect/);
    expect(text).toMatch(/unavailable/);
    expect(text).toMatch(/busy/);
    expect(text).toMatch(/disconnected/);
  });
});
