import { ConnectionStatus } from '../src/application/web/connection-status';

const principal = { userId: 'u1', clientId: 'c' } as never;

function connected(hasRegistration: () => Promise<boolean>, state = 'connected') {
  const offer = jest.fn();
  const link = { status: async () => ({ state, expiresAt: null }), offer, hasRegistration };
  const s = new ConnectionStatus({} as never, {} as never, {} as never, {} as never, link as never, Date.now, 30);
  return { s, offer };
}

describe('ConnectionStatus.siasb: conta já conectada e matrícula', () => {
  it('com matrícula: offered true, status preservado, sem consultar o SIASB', async () => {
    const { s, offer } = connected(async () => true);
    expect(await s.siasb(principal)).toEqual({ offered: true, status: 'connected', expiresAt: null });
    expect(offer).not.toHaveBeenCalled();
  });

  it('matrícula apagada: offered false, status NÃO vira erro, sem consultar o SIASB', async () => {
    const { s, offer } = connected(async () => false, 'reconnect_required');
    expect(await s.siasb(principal)).toEqual({ offered: false, status: 'reconnect_required', expiresAt: null });
    expect(offer).not.toHaveBeenCalled();
  });

  it('falha ao olhar a matrícula: mantém o status e offered false', async () => {
    const { s } = connected(() => Promise.reject(new Error('x')));
    expect(await s.siasb(principal)).toEqual({ offered: false, status: 'connected', expiresAt: null });
  });
});

function status(offer: () => Promise<{ offered: boolean; courses: never[] }>, timeoutMs: number) {
  const link = { status: async () => ({ state: 'disconnected', expiresAt: null }), offer };
  return new ConnectionStatus({} as never, {} as never, {} as never, {} as never, link as never, Date.now, timeoutMs);
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
