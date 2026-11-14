import {
  MemoryAdminError,
  MemoryUserRecord,
  MemoryUserRepository,
} from '../src/application/memory/memory-ports';
import { memoryUsernameOf, MemoryUsers, PROXY_LABEL } from '../src/application/memory/memory-users';
import type { EncryptedSecret } from '../src/application/ports/repositories';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient, validateMemoryUrl } from '../src/infrastructure/memory/memory-admin.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { Secret } from '../src/application/shared/secret';

const ROOT = 'root-token-unit-test-0001';
const KEY = Buffer.alloc(32, 7).toString('base64');
const UID = '01a1db61-e0d4-7261-ae1d-0b563922fde5';

class MemoryRepo extends MemoryUserRepository {
  rows = new Map<string, MemoryUserRecord>();
  failMarkReadyOnce = false;
  async find(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async createIfAbsent(input: { userId: string; memoryUsername: string }) {
    const cur = this.rows.get(input.userId);
    if (cur) return cur;
    const row: MemoryUserRecord = {
      userId: input.userId,
      memoryUsername: input.memoryUsername,
      status: 'creating',
      proxyCredentialId: null,
      proxyKey: null,
      displayName: null,
    };
    this.rows.set(input.userId, row);
    return row;
  }
  async saveProxyIfAbsent(
    userId: string,
    input: { credentialId: string; key: EncryptedSecret; displayName: string | null },
  ) {
    const row = this.rows.get(userId)!;
    if (row.proxyCredentialId) return false;
    Object.assign(row, { proxyCredentialId: input.credentialId, proxyKey: input.key, displayName: input.displayName });
    return true;
  }
  async markReady(userId: string) {
    if (this.failMarkReadyOnce) {
      this.failMarkReadyOnce = false;
      throw new Error('db down');
    }
    this.rows.get(userId)!.status = 'ready';
  }
}

describe('memória: MemoryAdminClient + MemoryUsers contra o fake do ai-memory', () => {
  let fake: FakeAiMemory;
  let url: string;
  let admin: MemoryAdminClient;
  let repo: MemoryRepo;
  let users: MemoryUsers;

  beforeEach(async () => {
    fake = new FakeAiMemory(ROOT);
    url = await fake.start();
    admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    repo = new MemoryRepo();
    users = new MemoryUsers(admin, repo, new AesSecretCipher(KEY));
  });
  afterEach(() => fake.stop());

  it('username é u + 12 hex, estável e sem PII', () => {
    expect(memoryUsernameOf(UID)).toBe('u0b563922fde5');
    expect(memoryUsernameOf(UID)).toBe(memoryUsernameOf(UID));
  });

  it('ensure cria o usuário com o nome do Google, sem e-mail, e uma chave de repasse cifrada', async () => {
    const r = await users.ensure(UID, 'Fulana de Tal');
    expect(r.username).toBe('u0b563922fde5');
    expect(fake.users).toHaveLength(1);
    expect(fake.users[0].name).toBe('Fulana de Tal');
    const created = fake.requests.find((q) => q.path === '/admin/human-users')!;
    expect(Object.keys(created.body as object).sort()).toEqual(['name', 'username']);
    const row = repo.rows.get(UID)!;
    expect(row.status).toBe('ready');
    const cred = fake.credentials[0];
    expect(cred.label).toBe(PROXY_LABEL);
    expect(JSON.stringify(row.proxyKey)).not.toContain(cred.token);
    expect((await users.proxyKey(UID)).reveal()).toBe(cred.token);
    expect(fake.authenticate(cred.token)?.username).toBe('u0b563922fde5');
  });

  it('é idempotente: a segunda chamada não fala com o memory', async () => {
    await users.ensure(UID, 'Fulana');
    const n = fake.requests.length;
    await users.ensure(UID, 'Fulana');
    expect(fake.requests).toHaveLength(n);
    expect(fake.credentials).toHaveLength(1);
  });

  it('chamadas simultâneas da mesma pessoa criam uma só chave', async () => {
    await Promise.all([users.ensure(UID, 'A'), users.ensure(UID, 'A'), users.ensure(UID, 'A')]);
    expect(fake.users).toHaveLength(1);
    expect(fake.credentials.filter((c) => !c.revoked_at)).toHaveLength(1);
  });

  it('é retomável: cai depois de criar a chave, a nova tentativa revoga a órfã e termina', async () => {
    repo.failMarkReadyOnce = true;
    await expect(users.ensure(UID, 'Fulana')).rejects.toThrow('db down');
    // simula a perda do segredo da primeira chave (queda antes de gravar)
    const row = repo.rows.get(UID)!;
    row.proxyCredentialId = null;
    row.proxyKey = null;
    await users.ensure(UID, 'Fulana');
    expect(repo.rows.get(UID)!.status).toBe('ready');
    const active = fake.credentials.filter((c) => !c.revoked_at);
    expect(active).toHaveLength(1);
    expect(fake.credentials).toHaveLength(2);
    expect(fake.users).toHaveLength(1);
  });

  it('retoma quando o usuário já existe no memory (409 não é erro)', async () => {
    await admin.createHumanUser({ username: memoryUsernameOf(UID) });
    await expect(users.ensure(UID, 'Fulana')).resolves.toEqual({ username: 'u0b563922fde5' });
    expect(fake.users).toHaveLength(1);
  });

  it('corrida perdida na gravação revoga a credencial que sobrou', async () => {
    const original = repo.saveProxyIfAbsent.bind(repo);
    repo.saveProxyIfAbsent = async () => false;
    await users.ensure(UID, 'Fulana');
    repo.saveProxyIfAbsent = original;
    expect(fake.credentials.filter((c) => !c.revoked_at)).toHaveLength(0);
  });

  it('sem token root: indisponível, sem chamar ninguém', async () => {
    const off = new MemoryAdminClient({ baseUrl: url });
    expect(off.isConfigured()).toBe(false);
    await expect(new MemoryUsers(off, repo, new AesSecretCipher(KEY)).ensure(UID)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('usuário desativado na ufba.app não é recriado', async () => {
    await users.ensure(UID, 'Fulana');
    repo.rows.get(UID)!.status = 'disabled';
    await expect(users.ensure(UID)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('credenciais: last_used_at aparece só depois do uso, revoke corta só uma, rotate invalida o texto antigo', async () => {
    await users.ensure(UID, 'Fulana');
    const a = await admin.issueCredential('u0b563922fde5', 'pc:aaaa:notebook');
    const b = await admin.issueCredential('u0b563922fde5', 'pc:bbbb:desktop');
    let list = await admin.listCredentials('u0b563922fde5');
    expect(list.find((c) => c.id === a.credential.id)!.lastUsedAt).toBeNull();
    fake.authenticate(a.token.reveal());
    list = await admin.listCredentials('u0b563922fde5');
    expect(list.find((c) => c.id === a.credential.id)!.lastUsedAt).toBeInstanceOf(Date);
    await admin.revokeCredential(a.credential.id);
    expect(fake.authenticate(a.token.reveal())).toBeNull();
    expect(fake.authenticate(b.token.reveal())).not.toBeNull();
    const rotated = await admin.rotateCredential(b.credential.id);
    expect(fake.authenticate(b.token.reveal())).toBeNull();
    expect(fake.authenticate(rotated.token.reveal())).not.toBeNull();
    expect(rotated.token.toString()).toBe('[redacted]');
  });

  it('disable não revoga chaves (comportamento do ai-memory); revoke antes é obrigatório', async () => {
    await users.ensure(UID, 'Fulana');
    const token = (await users.proxyKey(UID)).reveal();
    await admin.disableUser('u0b563922fde5');
    expect(fake.authenticate(token)).not.toBeNull();
  });

  it('grants, projetos e purge', async () => {
    await users.ensure(UID, 'Fulana');
    await admin.setProjectAccess('ufba-alunos', 'proj-ab12', 'restricted');
    await admin.grant('u0b563922fde5', 'ufba-alunos', 'proj-ab12', 'read');
    await admin.grant('u0b563922fde5', 'ufba-alunos', 'proj-ab12', 'write');
    expect(await admin.listGrants('u0b563922fde5')).toEqual([
      { username: 'u0b563922fde5', workspace: 'ufba-alunos', project: 'proj-ab12', level: 'write' },
    ]);
    expect(await admin.listProjects()).toEqual([{ workspace: 'ufba-alunos', project: 'proj-ab12' }]);
    await admin.revokeGrant('u0b563922fde5', 'ufba-alunos', 'proj-ab12');
    expect(await admin.listGrants('u0b563922fde5')).toEqual([]);
    await admin.purgeProject('ufba-alunos', 'proj-ab12');
    expect(await admin.listProjects()).toEqual([]);
    const purge = fake.requests.find((q) => q.path === '/admin/purge-project')!;
    expect(purge.body).toMatchObject({ confirm: true });
  });

  it('renameUser troca o nome de exibição', async () => {
    await users.ensure(UID, 'Fulana');
    await admin.renameUser('u0b563922fde5', 'Ex-participante');
    expect((await admin.findUser('u0b563922fde5'))?.name).toBe('Ex-participante');
  });

  it('erros: kind pelo status e nunca o corpo da resposta', async () => {
    fake.failNext = { path: /human-users/, status: 500 };
    const err = await admin.createHumanUser({ username: 'ux' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryAdminError);
    expect((err as MemoryAdminError).kind).toBe('unavailable');
    expect(String(err)).not.toContain('CANARIO');
    expect(await admin.findUser('nao-existe')).toBeNull();
    await expect(admin.revokeCredential('nao-existe')).rejects.toMatchObject({ kind: 'not_found', status: 404 });
    const wrong = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of('outro') });
    await expect(wrong.listProjects()).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('servidor fora do ar vira unavailable, sem vazar URL nem cabeçalhos', async () => {
    await fake.stop();
    const err = await admin.listProjects().catch((e: unknown) => e);
    expect((err as MemoryAdminError).kind).toBe('unavailable');
    expect(String(err) + JSON.stringify(err)).not.toContain(ROOT);
    expect(String(err)).not.toContain('127.0.0.1');
    fake = new FakeAiMemory(ROOT); // para o afterEach
  });

  it('só chama caminhos fixos de /admin/ com o token root', async () => {
    await users.ensure(UID, 'Fulana');
    for (const q of fake.requests) {
      expect(q.path.startsWith('/admin/')).toBe(true);
      expect(q.authorization).toBe(`Bearer ${ROOT}`);
    }
  });
});

describe('validateMemoryUrl', () => {
  it('exige https (http só em loopback) e recusa *.up.railway.app', () => {
    expect(validateMemoryUrl('https://memory.ufba.app').hostname).toBe('memory.ufba.app');
    expect(validateMemoryUrl('http://127.0.0.1:9').port).toBe('9');
    expect(() => validateMemoryUrl('http://memory.ufba.app')).toThrow();
    expect(() => validateMemoryUrl('https://memory-production.up.railway.app')).toThrow();
  });
});
