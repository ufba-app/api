import { Logger } from '@nestjs/common';
import { MemoryComputers } from '../src/application/memory/memory-computers';
import { GrantReconciler } from '../src/application/memory/grant-reconciler';
import { MemoryMaintenance } from '../src/application/memory/memory-maintenance';
import { MemoryUsers } from '../src/application/memory/memory-users';
import { OpenMemoryAccess, SeededProjectRegistry } from '../src/application/memory/memory-defaults';
import { MemoryProxy } from '../src/application/memory/memory-proxy';
import { ProxyKeyRotation, ProxyKeyStore } from '../src/application/memory/proxy-key-rotation';
import type { EncryptedSecret } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import {
  InMemoryComputerRepo,
  InMemoryProjectRepo,
  InMemorySyncJobRepo,
  InMemoryUserRepo,
  StubTeamGrants,
} from './support/memory-fakes';

const ROOT = 'root-token-hardening-0009';
const UID = 'u-aaaaaaaaaaaa';
const DAY = 86_400_000;

describe('endurecimento: rotação da chave de repasse, alertas', () => {
  let fake: FakeAiMemory;
  let clock: number;
  let repo: InMemoryUserRepo;
  let rotatedAt: Map<string, Date>;
  let failReplace: boolean;
  let admin: MemoryAdminClient;
  let users: MemoryUsers;
  let rotation: ProxyKeyRotation;

  const store: ProxyKeyStore = {
    replace: async (userId: string, key: EncryptedSecret, at: Date) => {
      if (failReplace) throw new Error('db down');
      repo.rows.get(userId)!.proxyKey = key;
      rotatedAt.set(userId, at);
    },
    reset: async (userId: string) => {
      Object.assign(repo.rows.get(userId)!, { status: 'creating', proxyCredentialId: null, proxyKey: null });
    },
    listStale: async (before: Date, limit: number) =>
      [...repo.rows.values()]
        .filter((r) => r.status === 'ready' && r.proxyCredentialId && (rotatedAt.get(r.userId) ?? createdAt.get(r.userId)!) < before)
        .map((r) => r.userId)
        .slice(0, limit),
  };
  const createdAt = new Map<string, Date>();

  beforeEach(async () => {
    clock = 1_700_000_000_000;
    failReplace = false;
    rotatedAt = new Map();
    createdAt.clear();
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    repo = new InMemoryUserRepo();
    const cipher = new AesSecretCipher(Buffer.alloc(32, 8).toString('base64'));
    users = new MemoryUsers(admin, repo, cipher);
    rotation = new ProxyKeyRotation(admin, repo, store, cipher, () => clock);
    await users.ensure(UID);
    createdAt.set(UID, new Date(clock));
  });
  afterEach(() => fake.stop());

  it('gira a chave de UMA pessoa: a antiga morre, a nova é a que o proxy usa, o root não muda', async () => {
    const old = (await users.proxyKey(UID)).reveal();
    expect(await rotation.rotate(UID)).toBe(true);
    const fresh = (await users.proxyKey(UID)).reveal();
    expect(fresh).not.toBe(old);
    expect(fake.authenticate(old)).toBeNull();
    expect(fake.authenticate(fresh)?.username).toBe(`u${UID.replace(/-/g, '').slice(-12)}`);
    expect(fake.requests.every((q) => q.authorization === `Bearer ${ROOT}`)).toBe(true);
    expect(rotatedAt.get(UID)!.getTime()).toBe(clock);
  });

  it('o proxy do MCP segue funcionando depois da rotação, sem reiniciar nada', async () => {
    const proxy = new MemoryProxy(
      admin,
      users,
      new MemoryMcpClient({ baseUrl: `http://127.0.0.1:${portOf(fake)}` }),
      new SeededProjectRegistry(),
      new OpenMemoryAccess(),
      new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => clock),
    );
    const q = { workspace: 'ufba-app', project: 'api' };
    expect((await proxy.call(UID, 'memory_query', q))!.isError).toBeUndefined();
    await rotation.rotate(UID);
    expect((await proxy.call(UID, 'memory_query', q))!.isError).toBeUndefined();
    expect(fake.mcpCalls).toHaveLength(2);
  });

  it('se não der para gravar a nova, revoga a credencial e volta a creating: nunca sobra chave válida sem dono', async () => {
    const old = (await users.proxyKey(UID)).reveal();
    failReplace = true;
    await expect(rotation.rotate(UID)).rejects.toThrow('db down');
    expect(fake.authenticate(old)).toBeNull();
    expect(fake.credentials.filter((c) => !c.revoked_at)).toHaveLength(0);
    expect(repo.rows.get(UID)).toMatchObject({ status: 'creating', proxyCredentialId: null, proxyKey: null });
    // o próximo uso recupera sozinho
    failReplace = false;
    await users.ensure(UID);
    expect(repo.rows.get(UID)!.status).toBe('ready');
    expect(fake.credentials.filter((c) => !c.revoked_at)).toHaveLength(1);
  });

  it('pessoa sem chave de repasse não tem o que girar', async () => {
    expect(await rotation.rotate('u-nunca-usou')).toBe(false);
  });

  it('a varredura gira só as chaves mais velhas que o limite (90 dias) e respeita o teto por execução', async () => {
    expect(await rotation.rotateStale(90)).toBe(0);
    clock += 91 * DAY;
    expect(await rotation.rotateStale(90)).toBe(1);
    expect(await rotation.rotateStale(90)).toBe(0); // acabou de girar
    expect(await rotation.rotateStale(0, 20)).toBe(0); // girou neste instante
    clock += DAY;
    expect(await rotation.rotateStale(0)).toBe(1); // 0 dias = incidente: gira todas
  });

  it('memory fora do ar: a varredura não explode e tenta de novo depois', async () => {
    clock += 91 * DAY;
    const old = (await users.proxyKey(UID)).reveal();
    await fake.stop();
    expect(await rotation.rotateStale(90)).toBe(0);
    expect(rotatedAt.has(UID)).toBe(false);
    void old;
    fake = new FakeAiMemory(ROOT);
  });

  it('manutenção reporta as chaves giradas', async () => {
    clock += 91 * DAY;
    const projects = new InMemoryProjectRepo();
    const reconciler = new GrantReconciler({
      admin,
      users,
      projects,
      jobs: new InMemorySyncJobRepo(),
      team: new StubTeamGrants(),
      emailOf: async () => null,
      now: () => clock,
    });
    const computers = new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => clock);
    const report = await new MemoryMaintenance(reconciler, computers, rotation, 90).run();
    expect(report.rotatedKeys).toBe(1);
  });

  it('limite de chamadas: alerta com id e ferramenta, uma vez por pessoa a cada 10 min, nunca com argumentos', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const proxy = new MemoryProxy(
      admin,
      users,
      new MemoryMcpClient({ baseUrl: `http://127.0.0.1:${portOf(fake)}` }),
      new SeededProjectRegistry(),
      new OpenMemoryAccess(),
      new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => clock),
      { now: () => clock, callsPerMinute: 1 },
    );
    const args = { workspace: 'ufba-app', project: 'api', body: 'CANARIO-conteudo' };
    await proxy.call(UID, 'memory_write_page', args);
    await proxy.call(UID, 'memory_write_page', args);
    await proxy.call(UID, 'memory_write_page', args);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain(`user=${UID}`);
    expect(msg).toContain('tool=memory_write_page');
    expect(msg).not.toContain('CANARIO');
    clock += 11 * 60_000;
    await proxy.call(UID, 'memory_write_page', args);
    await proxy.call(UID, 'memory_write_page', args);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

function portOf(f: FakeAiMemory): number {
  const s = (f as unknown as { server: { address(): { port: number } } }).server;
  return s.address().port;
}
