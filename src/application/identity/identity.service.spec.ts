import { Secret } from '../shared/secret';
import type {
  ApiKeyRepository,
  SourceAccountRepository,
  UpsertSourceAccountInput,
  UserRepository,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { IdentityService, InvalidAccountError } from './identity.service';

class FakeCipher extends SecretCipher {
  encrypt(plain: string) {
    return { ciphertext: Buffer.from(plain).reverse().toString('base64'), iv: 'iv', authTag: 'tag' };
  }
  decrypt(s: { ciphertext: string }) {
    return Buffer.from(s.ciphertext, 'base64').reverse().toString();
  }
}

function setup() {
  const keys = new Map<string, { id: string; userId: string; revoked?: boolean }>();
  const upserts: UpsertSourceAccountInput[] = [];
  const users = {
    create: async () => ({ id: 'u1', name: null, createdAt: new Date() }),
  } as unknown as UserRepository;
  const apiKeys = {
    create: async (i: { userId: string; keyHash: string }) => {
      keys.set(i.keyHash, { id: 'k1', userId: i.userId });
      return { id: 'k1', userId: i.userId };
    },
    findActiveByHash: async (h: string) => {
      const k = keys.get(h);
      return k && !k.revoked ? { id: k.id, userId: k.userId } : null;
    },
    touch: async () => undefined,
  } as unknown as ApiKeyRepository;
  const accounts = {
    upsert: async (i: UpsertSourceAccountInput) => {
      upserts.push(i);
      return { id: 'a1' };
    },
  } as unknown as SourceAccountRepository;
  const service = new IdentityService(users, apiKeys, accounts, new FakeCipher());
  return { service, keys, upserts };
}

describe('IdentityService', () => {
  it('emite chave uma vez, guarda só o hash e autentica', async () => {
    const { service, keys } = setup();
    const { userId, apiKey } = await service.criarUsuario({ name: 'Ana' });
    expect(userId).toBe('u1');
    expect(apiKey).toMatch(/^plt_/);
    expect([...keys.keys()].some((h) => h === apiKey)).toBe(false);
    expect(await service.authenticate(apiKey as string)).toEqual({ userId: 'u1' });
    expect(await service.authenticate('plt_errada')).toBeNull();
  });

  it('cifra o segredo de Moodle/Google antes de gravar', async () => {
    const { service, upserts } = setup();
    await service.conectarConta({
      userId: 'u1',
      provider: 'MOODLE',
      accountKey: 'moodle.x:ana',
      secretPlain: Secret.of('token-moodle'),
    });
    const secret = upserts[0].secret!;
    expect(JSON.stringify(secret)).not.toContain('token-moodle');
    expect(new FakeCipher().decrypt(secret)).toBe('token-moodle');
  });

  it('SIGAA nunca recebe segredo', async () => {
    const { service, upserts } = setup();
    await expect(
      service.conectarConta({
        userId: 'u1',
        provider: 'SIGAA',
        accountKey: 'sigaa',
        secretPlain: Secret.of('senha'),
      }),
    ).rejects.toBeInstanceOf(InvalidAccountError);
    expect(upserts).toHaveLength(0);
    await service.conectarConta({ userId: 'u1', provider: 'SIGAA', accountKey: 'sigaa' });
    expect(upserts[0].secret).toBeUndefined();
  });
});
