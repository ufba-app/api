import { PrismaSigaaCredentialRepository } from './prisma-identity.repositories';
import type { PrismaService } from './prisma.service';

const secret = { ciphertext: 'Y2lwaGVy', iv: 'aXY=', authTag: 'dGFn' };
const row = {
  id: 'c1',
  userId: 'u1',
  clientId: 'cli1',
  login: 'aluno.fake',
  secretCiphertext: secret.ciphertext,
  secretIv: secret.iv,
  secretAuthTag: secret.authTag,
  status: 'OK' as const,
  createdAt: new Date('2026-11-04T00:00:00Z'),
};

function setup() {
  const sigaaCredential = {
    upsert: jest.fn().mockResolvedValue(row),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const repo = new PrismaSigaaCredentialRepository({ sigaaCredential } as unknown as PrismaService);
  return { repo, sigaaCredential };
}

describe('PrismaSigaaCredentialRepository', () => {
  it('upsert substitui a credencial do mesmo (userId, clientId)', async () => {
    const { repo, sigaaCredential } = setup();
    const rec = await repo.upsert({ userId: 'u1', clientId: 'cli1', login: 'aluno.fake', secret });
    const cols = {
      login: 'aluno.fake',
      secretCiphertext: secret.ciphertext,
      secretIv: secret.iv,
      secretAuthTag: secret.authTag,
    };
    expect(sigaaCredential.upsert).toHaveBeenCalledWith({
      where: { userId_clientId: { userId: 'u1', clientId: 'cli1' } },
      create: { userId: 'u1', clientId: 'cli1', ...cols },
      update: { ...cols, status: 'OK' },
    });
    expect(rec).toEqual({
      id: 'c1',
      userId: 'u1',
      clientId: 'cli1',
      login: 'aluno.fake',
      secret,
      status: 'OK',
      createdAt: row.createdAt,
    });
  });

  it('find devolve null quando não há', async () => {
    const { repo, sigaaCredential } = setup();
    sigaaCredential.findUnique.mockResolvedValue(null);
    await expect(repo.find('u1', 'cli1')).resolves.toBeNull();
    expect(sigaaCredential.findUnique).toHaveBeenCalledWith({
      where: { userId_clientId: { userId: 'u1', clientId: 'cli1' } },
    });
  });

  it('find devolve o registro com o segredo remontado', async () => {
    const { repo, sigaaCredential } = setup();
    sigaaCredential.findUnique.mockResolvedValue(row);
    expect((await repo.find('u1', 'cli1'))?.secret).toEqual(secret);
  });

  it('setStatus atualiza o status pelo id', async () => {
    const { repo, sigaaCredential } = setup();
    await repo.setStatus('c1', 'REAUTH_NEEDED');
    expect(sigaaCredential.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'REAUTH_NEEDED' },
    });
  });
});
