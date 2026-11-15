import { PrismaSigaaSessionStore } from './prisma-sigaa-session.store';
import type { PrismaService } from './prisma.service';

const KEY = { userId: '0192b3c4-0000-7000-8000-000000000001', login: 'aluno.fake' };
const cookie = { ciphertext: 'Y2lwaGVy', iv: 'aXY=', authTag: 'dGFn' };

function setup() {
  const sigaaSession = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn(),
  };
  const $queryRaw = jest.fn();
  const store = new PrismaSigaaSessionStore({ sigaaSession, $queryRaw } as unknown as PrismaService);
  return { store, sigaaSession, $queryRaw };
}

describe('PrismaSigaaSessionStore', () => {
  it('acquire: devolve um token quando o comando atômico pega a trava', async () => {
    const { store, $queryRaw } = setup();
    $queryRaw.mockResolvedValue([{ lock_token: 'x' }]);
    const token = await store.acquire(KEY, 120_000);
    expect(token).toEqual(expect.any(String));
    expect($queryRaw).toHaveBeenCalledTimes(1);
    // o comando só atualiza trava vencida: a cláusula está no SQL, não numa leitura seguida de escrita
    const sql = ($queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('ON CONFLICT (user_id, login) DO UPDATE');
    expect(sql).toContain('locked_until < now()');
  });

  it('acquire: null quando outra execução detém a trava (0 linhas)', async () => {
    const { store, $queryRaw } = setup();
    $queryRaw.mockResolvedValue([]);
    await expect(store.acquire(KEY, 120_000)).resolves.toBeNull();
  });

  it('save e delete só valem para quem tem o token da trava', async () => {
    const { store, sigaaSession } = setup();
    await expect(store.save(KEY, 'tok', { cookie, lastUsedAt: 1_000 })).resolves.toBe(true);
    expect(sigaaSession.updateMany).toHaveBeenCalledWith({
      where: { userId: KEY.userId, login: KEY.login, lockToken: 'tok' },
      data: {
        cookieCiphertext: cookie.ciphertext,
        cookieIv: cookie.iv,
        cookieAuthTag: cookie.authTag,
        lastUsedAt: new Date(1_000),
      },
    });
    sigaaSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(store.save(KEY, 'perdeu', { cookie, lastUsedAt: 2 })).resolves.toBe(false);
    await expect(store.delete(KEY, 'perdeu')).resolves.toBe(false);
  });

  it('release solta só a trava do próprio token', async () => {
    const { store, sigaaSession } = setup();
    await store.release(KEY, 'tok');
    expect(sigaaSession.updateMany).toHaveBeenCalledWith({
      where: { userId: KEY.userId, login: KEY.login, lockToken: 'tok' },
      data: { lockToken: null, lockedUntil: null },
    });
  });

  it('load: linha sem cookie (só a trava) é "sem sessão"; com cookie devolve o cifrado', async () => {
    const { store, sigaaSession } = setup();
    sigaaSession.findUnique.mockResolvedValueOnce({ cookieCiphertext: null, cookieIv: null, cookieAuthTag: null, lastUsedAt: null });
    await expect(store.load(KEY)).resolves.toBeNull();
    sigaaSession.findUnique.mockResolvedValueOnce({
      cookieCiphertext: cookie.ciphertext,
      cookieIv: cookie.iv,
      cookieAuthTag: cookie.authTag,
      lastUsedAt: new Date(5_000),
    });
    await expect(store.load(KEY)).resolves.toEqual({ cookie, lastUsedAt: 5_000 });
  });
});
