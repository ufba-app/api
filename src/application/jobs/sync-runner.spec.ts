import { runSyncJob } from './sync-runner';
import type { SyncOutcome, SyncProvider } from './sync-provider';

interface Fake {
  provider: SyncProvider;
  calls: string[];
  dueUsers: jest.Mock;
  syncUser: jest.Mock;
}

function fake(
  key: string,
  ids: string[],
  outcomes: Record<string, SyncOutcome | Error> = {},
  cfg: Partial<Pick<SyncProvider, 'maxUsersPerRun' | 'spacingMs' | 'maxConsecutiveUnavailable'>> = {},
  events: string[] = [],
): Fake {
  const calls: string[] = [];
  const dueUsers = jest.fn(async (_now: Date, _limit: number) => ids);
  const syncUser = jest.fn(async (id: string) => {
    calls.push(id);
    events.push(`${key}:${id}`);
    const o = outcomes[id] ?? 'OK';
    if (o instanceof Error) throw o;
    return o;
  });
  const provider: SyncProvider = {
    key,
    maxUsersPerRun: cfg.maxUsersPerRun ?? 200,
    spacingMs: cfg.spacingMs ?? 1500,
    maxConsecutiveUnavailable: cfg.maxConsecutiveUnavailable ?? 3,
    dueUsers,
    syncUser,
  };
  return { provider, calls, dueUsers, syncUser };
}

describe('runSyncJob', () => {
  let out: string[];
  const spies: jest.SpyInstance[] = [];
  const now = () => new Date('2026-11-15T12:00:00Z');
  let sleeps: number[];
  let events: string[];
  let sleep: jest.Mock<Promise<void>, [number]>;

  beforeEach(() => {
    out = [];
    sleeps = [];
    events = [];
    sleep = jest.fn(async (ms: number) => {
      sleeps.push(ms);
      events.push('sleep');
    });
    const grab = (...a: unknown[]) => void out.push(a.map(String).join(' '));
    spies.push(
      jest.spyOn(console, 'log').mockImplementation(grab),
      jest.spyOn(console, 'error').mockImplementation(grab),
      jest.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true)),
      jest.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => (out.push(String(s)), true)),
    );
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  const run = (providers: SyncProvider[]) => runSyncJob({ providers, now, sleep });

  it('processa só quem dueUsers devolve, na ordem, passando o limite do provedor', async () => {
    const f = fake('p', ['u-a', 'u-b', 'u-c'], {}, { maxUsersPerRun: 7 });
    expect(await run([f.provider])).toBe(0);
    expect(f.calls).toEqual(['u-a', 'u-b', 'u-c']);
    expect(f.dueUsers).toHaveBeenCalledWith(now(), 7);
  });

  it('3 UNAVAILABLE seguidos interrompem a rodada: restantes não são chamados, código 0, log só com contagens', async () => {
    const un: SyncOutcome = 'UNAVAILABLE';
    const f = fake('p', ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'], { 'u-a': un, 'u-b': un, 'u-c': un });
    expect(await run([f.provider])).toBe(0);
    expect(f.calls).toEqual(['u-a', 'u-b', 'u-c']);
    const text = out.join(' ');
    expect(text).toContain('rodada interrompida: provedor indisponível várias vezes seguidas');
    expect(text).toContain('3 unavailable');
    expect(text).not.toMatch(/u-[a-e]/);
  });

  it('um resultado diferente no meio zera a sequência de UNAVAILABLE', async () => {
    const un: SyncOutcome = 'UNAVAILABLE';
    const f = fake('p', ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'], { 'u-a': un, 'u-b': un, 'u-c': 'OK', 'u-d': un, 'u-e': un });
    await run([f.provider]);
    expect(f.calls).toEqual(['u-a', 'u-b', 'u-c', 'u-d', 'u-e']);
    expect(out.join(' ')).not.toContain('interrompida');
  });

  it('dorme entre pessoas com spacingMs, não depois da última', async () => {
    const f = fake('p', ['u-a', 'u-b', 'u-c'], {}, { spacingMs: 1500 }, events);
    await run([f.provider]);
    expect(events).toEqual(['p:u-a', 'sleep', 'p:u-b', 'sleep', 'p:u-c']);
    expect(sleeps).toEqual([1500, 1500]);
  });

  it('sem ninguém devido: não sincroniza nem dorme, código 0', async () => {
    const f = fake('p', []);
    expect(await run([f.provider])).toBe(0);
    expect(f.syncUser).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('um syncUser que lança não interrompe os demais e zera a sequência; código 0', async () => {
    const un: SyncOutcome = 'UNAVAILABLE';
    const f = fake('p', ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'], {
      'u-a': un,
      'u-b': un,
      'u-c': new Error('paciente Fulano de Tal'),
      'u-d': un,
      'u-e': un,
    });
    expect(await run([f.provider])).toBe(0);
    expect(f.calls).toEqual(['u-a', 'u-b', 'u-c', 'u-d', 'u-e']);
    const text = out.join('\n');
    expect(text).not.toContain('Fulano');
    expect(text).toContain('1 falhas');
  });

  it('dueUsers lançando, sendo o único provedor, devolve 1 com linha fixa', async () => {
    const f = fake('p', []);
    f.dueUsers.mockRejectedValueOnce(new Error('db caiu com segredo-xyz'));
    expect(await run([f.provider])).toBe(1);
    expect(f.syncUser).not.toHaveBeenCalled();
    const text = out.join('\n');
    expect(text).toContain('sync: p não foi possível listar quem sincronizar');
    expect(text).not.toContain('segredo-xyz');
  });

  it('loga só contagens (inclui DISCONNECTED), no formato fixo, e nenhum id', async () => {
    const f = fake('siasb', ['user-id-111', 'user-id-222', 'user-id-333', 'user-id-444', 'user-id-555', 'user-id-666'], {
      'user-id-222': 'RECONNECT_REQUIRED',
      'user-id-333': 'UNAVAILABLE',
      'user-id-444': 'BUSY',
      'user-id-555': 'DISCONNECTED',
      'user-id-666': new Error('x'),
    });
    await run([f.provider]);
    const text = out.join('\n');
    expect(text).not.toMatch(/user-id/);
    expect(text).toContain(
      'sync: siasb 6 devidos, 1 ok, 1 reconnect, 1 unavailable, 1 busy, 1 disconnected, 1 falhas',
    );
  });

  it('dois provedores: cada um com seu limite, espaçamento e breaker', async () => {
    const un: SyncOutcome = 'UNAVAILABLE';
    const a = fake('a', ['a1', 'a2', 'a3'], {}, { maxUsersPerRun: 10, spacingMs: 100 }, events);
    const b = fake(
      'b',
      ['b1', 'b2', 'b3'],
      { b1: un, b2: un },
      { maxUsersPerRun: 20, spacingMs: 300, maxConsecutiveUnavailable: 2 },
      events,
    );
    expect(await run([a.provider, b.provider])).toBe(0);
    expect(a.dueUsers).toHaveBeenCalledWith(now(), 10);
    expect(b.dueUsers).toHaveBeenCalledWith(now(), 20);
    expect(sleeps).toEqual([100, 100, 300]);
    expect(a.calls).toEqual(['a1', 'a2', 'a3']);
    expect(b.calls).toEqual(['b1', 'b2']);
    const text = out.join('\n');
    expect(text).toContain('sync: a 3 devidos');
    expect(text).toMatch(/sync: b 3 devidos.*interrompida/);
  });

  it('o breaker do primeiro provedor não para o segundo', async () => {
    const un: SyncOutcome = 'UNAVAILABLE';
    const a = fake('a', ['a1', 'a2', 'a3'], { a1: un, a2: un, a3: un });
    const b = fake('b', ['b1', 'b2']);
    expect(await run([a.provider, b.provider])).toBe(0);
    expect(b.calls).toEqual(['b1', 'b2']);
  });

  it('dueUsers do primeiro lançando não para o segundo; código 0', async () => {
    const a = fake('a', []);
    a.dueUsers.mockRejectedValueOnce(new Error('boom'));
    const b = fake('b', ['b1']);
    expect(await run([a.provider, b.provider])).toBe(0);
    expect(b.calls).toEqual(['b1']);
    expect(out.join('\n')).toContain('sync: a não foi possível listar quem sincronizar');
  });

  it('dueUsers falhando em todos os provedores devolve 1', async () => {
    const a = fake('a', []);
    const b = fake('b', []);
    a.dueUsers.mockRejectedValueOnce(new Error('x'));
    b.dueUsers.mockRejectedValueOnce(new Error('y'));
    expect(await run([a.provider, b.provider])).toBe(1);
  });

  it('zero provedores: código 0 e linha fixa', async () => {
    expect(await run([])).toBe(0);
    expect(out.join('\n')).toContain('sync: nenhum provedor registrado');
  });

  it('canário: mensagens de erro e ids nunca aparecem na saída', async () => {
    const a = fake('a', ['id-secreto-1', 'id-secreto-2'], { 'id-secreto-1': new Error('CANARIO-ERRO-1') });
    const b = fake('b', []);
    b.dueUsers.mockRejectedValueOnce(new Error('CANARIO-ERRO-2'));
    await run([a.provider, b.provider]);
    expect(out.join('\n')).not.toMatch(/CANARIO|id-secreto/);
  });
});
