import {
  SourceAccountRepository,
  type EncryptedSecret,
  type SourceAccountRecord,
  type UpsertSourceAccountInput,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, type SiasbSession } from '../ports/siasb-source';
import { ReconectarError, SiasbReadError, SiasbSessionRunner } from './siasb-session-runner';

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [];
  statuses: { id: string; status: string }[] = [];
  failUpdate = false;
  updates: { id: string; secret: EncryptedSecret; expiresAt?: Date }[] = [];
  async upsert(_i: UpsertSourceAccountInput): Promise<SourceAccountRecord> {
    throw new Error('no');
  }
  async findByUserAndProvider(userId: string, provider: string) {
    return this.rows.filter((r) => r.userId === userId && r.provider === provider);
  }
  async listByUser() {
    return [];
  }
  async setStatus(id: string, status: SourceAccountRecord['status']) {
    this.statuses.push({ id, status });
    this.rows.forEach((r) => r.id === id && (r.status = status));
  }
  async updateSecret(id: string, secret: EncryptedSecret, expiresAt?: Date) {
    if (this.failUpdate) throw new Error('P2025');
    this.updates.push({ id, secret, expiresAt });
  }
  async delete() {}
}

class FakeCipher extends SecretCipher {
  encrypt(plain: string): EncryptedSecret {
    return { ciphertext: plain, iv: 'iv', authTag: 'tag' };
  }
  decrypt(s: EncryptedSecret): string {
    return s.ciphertext;
  }
}

function setup(withAccount = true) {
  const accounts = new FakeAccounts();
  if (withAccount) {
    accounts.rows.push({
      id: 'acc1',
      userId: 'u1',
      provider: 'SIASB',
      accountKey: 'siasb',
      siteUrl: null,
      status: 'OK',
      lastSyncedAt: null,
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      secret: new FakeCipher().encrypt(JSON.stringify({ k: 'v' })),
    });
  }
  return { accounts, runner: new SiasbSessionRunner(accounts, new FakeCipher()) };
}

const renew = (s: SiasbSession) => {
  s.cookies = { ...s.cookies, fresh: 'novo' };
  s.expiresAt = new Date('2026-12-31T00:00:00Z');
  s.dirty = true;
};

const fail = (code: ConstructorParameters<typeof SiasbError>[0]) => async (): Promise<never> => {
  throw new SiasbError(code);
};

describe('SiasbSessionRunner', () => {
  it('abre o jar, devolve o resultado e regrava uma vez quando dirty', async () => {
    const { accounts, runner } = setup();
    let seen: Record<string, string> = {};
    const out = await runner.run('u1', async (s) => {
      seen = { ...s.cookies };
      renew(s);
      return 42;
    });
    expect(out).toBe(42);
    expect(seen).toEqual({ k: 'v' });
    expect(accounts.updates).toHaveLength(1);
    expect(JSON.parse(accounts.updates[0].secret.ciphertext)).toEqual({ k: 'v', fresh: 'novo' });
    expect(accounts.updates[0].expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('não regrava quando o jar não mudou', async () => {
    const { accounts, runner } = setup();
    await runner.run('u1', async () => 1);
    expect(accounts.updates).toHaveLength(0);
  });

  it('sem conta lança ReconectarError sem chamar fn', async () => {
    const { runner } = setup(false);
    const fn = jest.fn();
    await expect(runner.run('u1', fn)).rejects.toBeInstanceOf(ReconectarError);
    expect(fn).not.toHaveBeenCalled();
    await expect(runner.requireAccount('u1')).rejects.toBeInstanceOf(ReconectarError);
  });

  it('conta em REAUTH_NEEDED lança sem chamar fn', async () => {
    const { accounts, runner } = setup();
    accounts.rows[0].status = 'REAUTH_NEEDED';
    const fn = jest.fn();
    await expect(runner.run('u1', fn)).rejects.toBeInstanceOf(ReconectarError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('jar ilegível marca REAUTH_NEEDED sem vazar conteúdo', async () => {
    const { accounts, runner } = setup();
    accounts.rows[0].secret = { ciphertext: 'segredo-cookie{', iv: 'iv', authTag: 'tag' };
    const fn = jest.fn();
    const err = (await runner.run('u1', fn).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ReconectarError);
    expect(err.message).not.toContain('segredo-cookie');
    expect(accounts.statuses).toEqual([{ id: 'acc1', status: 'REAUTH_NEEDED' }]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('REAUTH_NEEDED no meio marca a conta, não regrava o jar e lança ReconectarError', async () => {
    const { accounts, runner } = setup();
    const err = await runner
      .run('u1', async (s) => {
        renew(s);
        throw new SiasbError('REAUTH_NEEDED');
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReconectarError);
    expect(accounts.statuses).toEqual([{ id: 'acc1', status: 'REAUTH_NEEDED' }]);
    expect(accounts.updates).toHaveLength(0);
  });

  it('mapeamento padrão: UNEXPECTED_FORMAT e os demais códigos viram SiasbReadError', async () => {
    const { accounts, runner } = setup();
    const a = await runner.run('u1', fail('UNEXPECTED_FORMAT')).catch((e) => e);
    expect(a).toBeInstanceOf(SiasbReadError);
    expect(a.code).toBe('siasb_unexpected_format');
    const b = await runner.run('u1', fail('UNAVAILABLE')).catch((e) => e);
    expect(b.code).toBe('siasb_unavailable');
    const c = await runner.run('u1', fail('WRITE_UNKNOWN')).catch((e) => e);
    expect(c.code).toBe('siasb_unavailable');
    expect(accounts.statuses).toEqual([]);
  });

  it('mapError customizado substitui o mapeamento, mas REAUTH_NEEDED continua sendo ReconectarError', async () => {
    const { accounts, runner } = setup();
    class Mine extends Error {}
    const mapError = jest.fn((e: SiasbError) => new Mine(e.code));
    const err = await runner.run('u1', fail('WRITE_REJECTED'), { mapError }).catch((e) => e);
    expect(err).toBeInstanceOf(Mine);
    expect(err.message).toBe('WRITE_REJECTED');
    const re = await runner.run('u1', fail('REAUTH_NEEDED'), { mapError }).catch((e) => e);
    expect(re).toBeInstanceOf(ReconectarError);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(accounts.statuses).toEqual([{ id: 'acc1', status: 'REAUTH_NEEDED' }]);
  });

  it('erro que não é do SIASB é relançado como está', async () => {
    const { runner } = setup();
    const err = await runner
      .run(
        'u1',
        async () => {
          throw new Error('boom');
        },
        { mapError: () => new Error('x') },
      )
      .catch((e) => e);
    expect(err.message).toBe('boom');
  });

  it('falha ao regravar não troca o resultado nem o erro', async () => {
    const { accounts, runner } = setup();
    accounts.failUpdate = true;
    await expect(
      runner.run('u1', async (s) => {
        renew(s);
        return 'ok';
      }),
    ).resolves.toBe('ok');
    const err = await runner
      .run('u1', async (s) => {
        renew(s);
        throw new SiasbError('UNAVAILABLE');
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SiasbReadError);
  });
});
