import { ConnectionStatus } from '../src/application/web/connection-status';

const principal = { userId: 'u1', clientId: 'c' } as never;

function status(offer: () => Promise<{ offered: boolean; courses: never[] }>, timeoutMs: number) {
  const link = { status: async () => ({ state: 'disconnected', expiresAt: null }), offer };
  return new ConnectionStatus({} as never, {} as never, {} as never, link as never, Date.now, timeoutMs);
}

describe('ConnectionStatus.siasb: teto de espera pelo SIASB no /me', () => {
  it('offer que não responde: offered false dentro do teto, sem erro', async () => {
    const s = status(() => new Promise(() => undefined), 30);
    const t0 = Date.now();
    expect(await s.siasb(principal)).toEqual({ offered: false, status: 'disconnected', expiresAt: null });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('offer que falha: offered false; offer rápido: offered true (e o timer não fica aberto)', async () => {
    const falha = status(async () => Promise.reject(new Error('x')), 5000);
    expect((await falha.siasb(principal)).offered).toBe(false);
    const ok = status(async () => ({ offered: true, courses: [] }), 5000);
    expect((await ok.siasb(principal)).offered).toBe(true);
  });
});
