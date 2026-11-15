import { ConnectionsService } from '../src/application/web/connections.service';
import { ApiError } from '../src/application/web/web-api';
import type { SyncOutcome } from '../src/application/siasb/siasb-syncer';

const principal = { userId: 'u1', clientId: 'c' } as never;
const cfg = { webOrigin: 'https://meu.ufba.app', institutionalDomain: 'ufba.br' };

function build(opts: {
  outcome?: SyncOutcome;
  onConnected?: (u: string) => Promise<void>;
  link?: unknown;
  now?: () => number;
}) {
  const runs: string[] = [];
  const link = opts.link ?? { connect: async () => undefined };
  const svc = new ConnectionsService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    link as never,
    cfg,
    opts.now ?? Date.now,
    async () => undefined,
    opts.onConnected,
    async (u) => {
      runs.push(u);
      return opts.outcome ?? 'OK';
    },
  );
  return { svc, runs };
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('não falhou');
}

describe('ConnectionsService.syncSiasb', () => {
  it.each([['OK'], ['BUSY']] as const)('%s: termina sem erro (204)', async (outcome) => {
    const { svc, runs } = build({ outcome });
    await expect(svc.syncSiasb(principal)).resolves.toBeUndefined();
    expect(runs).toEqual(['u1']);
  });

  it.each([
    ['RECONNECT_REQUIRED', 409, 'siasb_reconnect_required'],
    ['UNAVAILABLE', 503, 'siasb_unavailable'],
    ['DISCONNECTED', 404, 'not_found'],
  ] as const)('%s: %i %s', async (outcome, status, code) => {
    const { svc } = build({ outcome });
    const e = await failure(svc.syncSiasb(principal));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
  });

  it('4ª chamada em 10 min: 429 too_many_attempts sem chamar o sincronizador; depois da janela volta', async () => {
    let t = 1_000_000;
    const { svc, runs } = build({ now: () => t });
    for (let i = 0; i < 3; i++) await svc.syncSiasb(principal);
    const e = await failure(svc.syncSiasb(principal));
    expect(e.status).toBe(429);
    expect(e.code).toBe('too_many_attempts');
    expect(runs).toHaveLength(3);
    t += 10 * 60_000 + 1;
    await svc.syncSiasb(principal);
    expect(runs).toHaveLength(4);
  });

  it('o limite é por pessoa', async () => {
    const { svc, runs } = build({});
    for (let i = 0; i < 3; i++) await svc.syncSiasb(principal);
    await svc.syncSiasb({ userId: 'u2', clientId: 'c' } as never);
    expect(runs).toEqual(['u1', 'u1', 'u1', 'u2']);
  });
});

describe('ConnectionsService.connectSiasb dispara a sincronização', () => {
  it('chama onSiasbConnected uma vez depois de conectar, sem esperar por ele', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc } = build({
      link: { connect: async () => void order.push('connect') },
      onConnected: async (u) => {
        order.push(`sync:${u}`);
        await gate;
        order.push('sync-done');
      },
    });
    await svc.connectSiasb(principal, { password: 'x' });
    expect(order).toEqual(['connect', 'sync:u1']);
    release();
    await gate;
  });

  it('falha (rejeição ou exceção síncrona) do disparo não faz a conexão falhar', async () => {
    for (const boom of [async () => Promise.reject(new Error('x')), (() => { throw new Error('y'); }) as never]) {
      const { svc } = build({ onConnected: boom });
      await expect(svc.connectSiasb(principal, { password: 'x' })).resolves.toBeUndefined();
    }
  });

  it('conexão que falha não dispara a sincronização', async () => {
    const calls: string[] = [];
    const { svc } = build({
      link: { connect: async () => Promise.reject(new Error('recusado')) },
      onConnected: async (u) => void calls.push(u),
    });
    await expect(svc.connectSiasb(principal, { password: 'x' })).rejects.toThrow('recusado');
    expect(calls).toEqual([]);
  });
});
