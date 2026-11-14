/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeviceAuthorizationRepository, MemoryComputerRepository } from '../src/application/memory/device-ports';
import { MemoryAdmin, MemoryMcp, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { MemoryProjectRepository, MemorySyncJobRepository } from '../src/application/memory/project-ports';
import { TeamRoleRepository } from '../src/application/memory/team-ports';
import { OAUTH_STORE, USER_DIRECTORY } from '../src/application/oauth/oauth-ports';
import { sha256Base64Url } from '../src/application/oauth/pkce';
import { ApiKeyRepository } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { MemoryOAuthStore, MemoryUserDirectory } from '../src/interface/mcp/testing/memory-oauth-store';
import {
  InMemoryComputerRepo,
  InMemoryDeviceRepo,
  InMemoryProjectRepo,
  InMemorySyncJobRepo,
  InMemoryUserRepo,
} from './support/memory-fakes';

const WEB = 'http://localhost:3001';
const ROOT = 'CANARIO-root-projects-http-0007';

describe('memória: Meus projetos e exclusão de conta (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let fake: FakeAiMemory;
  let store: MemoryOAuthStore;
  let projects: InMemoryProjectRepo;
  let fulana: string;
  let beltrano: string;
  let cFulana: string;
  let cBeltrano: string;

  async function session(userId: string, token: string): Promise<string> {
    await store.saveToken({
      tokenHash: sha256Base64Url(token),
      kind: 'session',
      clientId: 'ufba-web',
      userId,
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return `ufba_session=${token}`;
  }

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.WEB_ORIGIN = WEB;
    process.env.AUTH_ORIGIN = 'http://localhost:3002';
    process.env.PUBLIC_URL = 'http://localhost:3000';
    delete process.env.GOOGLE_CLIENT_ID;
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    process.env.MEMORY_URL = url;
    const { AppModule } = await import('../src/app.module');
    store = new MemoryOAuthStore();
    projects = new InMemoryProjectRepo();
    const directory = new MemoryUserDirectory();
    fulana = (await directory.findOrCreateByEmail('fulana@ufba.br')).id;
    beltrano = (await directory.findOrCreateByEmail('beltrano@ufba.br')).id;

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OAUTH_STORE)
      .useValue(store)
      .overrideProvider(USER_DIRECTORY)
      .useValue(directory)
      .overrideProvider(ApiKeyRepository)
      .useValue({ findActiveByHash: async () => null })
      .overrideProvider(MemoryUserRepository)
      .useValue(new InMemoryUserRepo())
      .overrideProvider(DeviceAuthorizationRepository)
      .useValue(new InMemoryDeviceRepo())
      .overrideProvider(MemoryComputerRepository)
      .useValue(new InMemoryComputerRepo())
      .overrideProvider(MemoryProjectRepository)
      .useValue(projects)
      .overrideProvider(MemorySyncJobRepository)
      .useValue(new InMemorySyncJobRepo())
      .overrideProvider(TeamRoleRepository)
      .useValue({ listRoles: async () => [], rolesOf: async () => [], listAssignments: async () => [] })
      .overrideProvider(MemoryAdmin)
      .useValue(new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) }))
      .overrideProvider(MemoryMcp)
      .useValue(new MemoryMcpClient({ baseUrl: url }))
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    cFulana = await session(fulana, 'sessao-fulana');
    cBeltrano = await session(beltrano, 'sessao-beltrano');
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
    for (const k of ['WEB_ORIGIN', 'AUTH_ORIGIN', 'PUBLIC_URL', 'MEMORY_URL']) delete process.env[k];
  });

  const web = (method: string, path: string, who: string | null, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-ufba': '1',
        origin: WEB,
        ...(who ? { cookie: who } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const json = async (r: Response) => (await r.json()) as any;
  const enc = encodeURIComponent;

  it('exige sessão', async () => {
    expect((await web('GET', '/web/memory/projects', null)).status).toBe(401);
    expect((await web('POST', '/web/memory/projects', null, { name: 'x' })).status).toBe(401);
  });

  it('criar, listar, convidar, detalhar, mudar nível, transferir, sair e apagar', async () => {
    const created = await web('POST', '/web/memory/projects', cFulana, { name: 'Meu TCC' });
    expect(created.status).toBe(201);
    const p = await json(created);
    expect(p).toMatchObject({ title: 'Meu TCC', role: 'owner', team: false, workspace: 'ufba-alunos', sync: 'ok' });
    expect((await web('POST', '/web/memory/projects', cFulana, { name: 'meu tcc' })).status).toBe(409);
    expect((await json(await web('POST', '/web/memory/projects', cFulana, { name: 'meu tcc' }))).error).toBe('project_name_taken');
    expect((await web('POST', '/web/memory/projects', cFulana, { name: '' })).status).toBe(400);

    expect((await json(await web('GET', '/web/memory/projects', cBeltrano))).projects).toEqual([]);
    const bad = await web('PUT', `/web/memory/projects/${p.id}/members/${enc('x@gmail.com')}`, cFulana, { level: 'read' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe('invalid_email_domain');

    expect((await web('PUT', `/web/memory/projects/${p.id}/members/${enc('beltrano@ufba.br')}`, cFulana, { level: 'read' })).status).toBe(204);
    expect((await web('PUT', `/web/memory/projects/${p.id}/members/${enc('beltrano@ufba.br')}`, cFulana, { level: 'admin' })).status).toBe(400);
    const mine = (await json(await web('GET', '/web/memory/projects', cBeltrano))).projects;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ role: 'read', source: 'invite', membersCount: 2 });
    expect(fake.grants.some((g) => g.project === p.project && g.level === 'read')).toBe(true);

    const owner = await json(await web('GET', `/web/memory/projects/${p.id}`, cFulana));
    expect(owner.members).toEqual([{ email: 'beltrano@ufba.br', name: null, level: 'read', status: 'active' }]);
    expect(owner.marker).toContain('server    = "ufba"');
    expect((await json(await web('GET', `/web/memory/projects/${p.id}`, cBeltrano))).members).toEqual([]);
    expect((await web('PUT', `/web/memory/projects/${p.id}/members/${enc('x@ufba.br')}`, cBeltrano, { level: 'read' })).status).toBe(403);
    expect((await web('GET', `/web/memory/projects/inexistente`, cBeltrano)).status).toBe(404);

    await web('PUT', `/web/memory/projects/${p.id}/members/${enc('beltrano@ufba.br')}`, cFulana, { level: 'write' });
    expect((await web('POST', `/web/memory/projects/${p.id}/transfer`, cFulana, { email: 'beltrano@ufba.br' })).status).toBe(204);
    expect((await json(await web('GET', '/web/memory/projects', cBeltrano))).projects[0].role).toBe('owner');
    expect((await web('DELETE', `/web/memory/projects/${p.id}/members/${enc('fulana@ufba.br')}`, cFulana)).status).toBe(204); // sai
    expect((await json(await web('GET', '/web/memory/projects', cFulana))).projects).toEqual([]);
    expect((await web('DELETE', `/web/memory/projects/${p.id}`, cFulana)).status).toBe(404);
    expect((await web('DELETE', `/web/memory/projects/${p.id}`, cBeltrano)).status).toBe(204);
    expect(fake.projects.has(`ufba-alunos/${p.project}`)).toBe(false);
    expect(projects.projects.size).toBe(0);
  });

  it('DELETE /me: chaves revogadas, projeto entregue, usuário desativado, conta apagada', async () => {
    const p = await json(await web('POST', '/web/memory/projects', cFulana, { name: 'Herança' }));
    await web('PUT', `/web/memory/projects/${p.id}/members/${enc('beltrano@ufba.br')}`, cFulana, { level: 'write' });
    const proxyKeys = fake.credentials.map((c) => c.token);
    expect(proxyKeys.length).toBeGreaterThan(0);

    expect((await web('DELETE', '/me', cFulana)).status).toBe(204);
    expect(fake.credentials.filter((c) => !c.revoked_at && fake.users.find((u) => u.id === c.user_id)?.name === 'Ex-participante')).toEqual([]);
    expect(fake.users.some((u) => u.name === 'Ex-participante' && u.disabled_at)).toBe(true);
    expect(projects.projects.get(p.id)!.ownerId).toBe(beltrano);
    expect((await json(await web('GET', '/web/memory/projects', cBeltrano))).projects[0]).toMatchObject({ role: 'owner' });
  });
});
