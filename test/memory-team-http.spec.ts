/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DeviceAuthorizationRepository, MemoryComputerRepository } from '../src/application/memory/device-ports';
import { MemoryAdmin, MemoryMcp, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { MemoryProjectRepository, MemorySyncJobRepository } from '../src/application/memory/project-ports';
import { TeamRoleRepository, UserLister } from '../src/application/memory/team-ports';
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
const ROOT = 'CANARIO-root-team-0008';

class FakeRoles extends TeamRoleRepository {
  assignments: { userId: string; roleKey: string }[] = [];
  constructor(private readonly ids: Record<string, string>) {
    super();
  }
  async listRoles() {
    return [
      {
        key: 'maintainer',
        description: 'Mantenedor',
        grants: [
          { projectId: this.ids.api, level: 'write' as const },
          { projectId: this.ids.web, level: 'write' as const },
          { projectId: this.ids.docs, level: 'write' as const },
        ],
      },
    ];
  }
  async rolesOf(userId: string) {
    return this.assignments.filter((a) => a.userId === userId).map((a) => a.roleKey);
  }
  async listAssignments() {
    return this.assignments;
  }
  async assign(userId: string, roleKey: string) {
    if (!this.assignments.some((a) => a.userId === userId && a.roleKey === roleKey)) this.assignments.push({ userId, roleKey });
  }
  async unassign(userId: string, roleKey: string) {
    const n = this.assignments.length;
    this.assignments = this.assignments.filter((a) => !(a.userId === userId && a.roleKey === roleKey));
    return this.assignments.length < n;
  }
}

describe('memória: papéis do time e Administração (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let fake: FakeAiMemory;
  let store: MemoryOAuthStore;
  let fulana: string;
  let beltrano: string;
  let cFulana: string;
  let cBeltrano: string;
  let roles: FakeRoles;
  const people = () => [
    { id: fulana, name: 'Fulana', email: 'fulana@ufba.br' },
    { id: beltrano, name: 'Beltrano', email: 'beltrano@ufba.br' },
  ];

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
    process.env.MEMORY_ADMIN_EMAILS = 'Fulana@ufba.br';
    delete process.env.GOOGLE_CLIENT_ID;
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    process.env.MEMORY_URL = url;
    const { AppModule } = await import('../src/app.module');
    store = new MemoryOAuthStore();
    const directory = new MemoryUserDirectory();
    fulana = (await directory.findOrCreateByEmail('fulana@ufba.br')).id;
    beltrano = (await directory.findOrCreateByEmail('beltrano@ufba.br')).id;
    const projects = new InMemoryProjectRepo();
    const ids: Record<string, string> = {};
    for (const n of ['api', 'web', 'docs']) {
      ids[n] = `team-${n}`;
      await projects.insert({ id: ids[n], workspace: 'ufba-app', project: n, title: n.toUpperCase(), ownerId: null, createdAt: new Date() });
    }
    roles = new FakeRoles(ids);

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
      .useValue(roles)
      .overrideProvider(UserLister)
      .useValue({
        list: async () => people(),
        byIds: async (ids: string[]) => people().filter((u) => ids.includes(u.id)),
        search: async (q: string) =>
          people().filter((u) => (u.name + ' ' + u.email).toLowerCase().includes(q.toLowerCase())),
      })
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
    for (const k of ['WEB_ORIGIN', 'AUTH_ORIGIN', 'PUBLIC_URL', 'MEMORY_URL', 'MEMORY_ADMIN_EMAILS']) delete process.env[k];
  });

  const web = (method: string, path: string, who: string | null) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'x-ufba': '1', origin: WEB, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}), ...(who ? { cookie: who } : {}) },
      body: method === 'PUT' ? '{}' : undefined,
    });
  const json = async (r: Response) => (await r.json()) as any;
  const grantsOfBeltrano = () =>
    fake.grants
      .filter((g) => g.username === `u${beltrano.replace(/-/g, '').slice(-12)}`)
      .map((g) => `${g.workspace}/${g.project}:${g.level}`)
      .sort();

  it('só admin (e-mail de MEMORY_ADMIN_EMAILS, sem diferença de maiúsculas) acessa a Administração', async () => {
    for (const [m, p] of [
      ['GET', '/admin/team'],
      ['GET', '/admin/memory/sync'],
      ['GET', '/admin/team/people?q=be'],
      ['PUT', `/admin/team/members/${beltrano}/roles/maintainer`],
      ['DELETE', `/admin/team/members/${beltrano}/roles/maintainer`],
    ]) {
      const r = await web(m, p, cBeltrano);
      expect(r.status).toBe(403);
      expect((await json(r)).error).toBe('not_admin');
    }
    expect((await web('GET', '/admin/team', null)).status).toBe(401);
    expect((await json(await web('GET', '/memory/status', cFulana))).isAdmin).toBe(true);
    expect(fake.users).toHaveLength(0); // recusas não criaram nada no memory
  });

  it('só existe o papel de mantenedor; a visão geral lista só quem o tem', async () => {
    const t = await json(await web('GET', '/admin/team', cFulana));
    expect(t.roles.map((r: any) => r.key)).toEqual(['maintainer']);
    expect(t.roles[0].grants).toEqual([
      { workspace: 'ufba-app', project: 'api', title: 'API', level: 'write' },
      { workspace: 'ufba-app', project: 'web', title: 'WEB', level: 'write' },
      { workspace: 'ufba-app', project: 'docs', title: 'DOCS', level: 'write' },
    ]);
    expect(t.members).toEqual([]); // ninguém é mantenedor ainda: a lista não traz todo mundo
    // não existe rota para editar papéis
    expect((await web('PUT', '/admin/team/roles/maintainer', cFulana)).status).toBe(404);
  });

  it('a busca de pessoas pede 2 letras, acha por nome ou e-mail e mostra quem já é mantenedor', async () => {
    expect(await json(await web('GET', '/admin/team/people?q=b', cFulana))).toEqual({ people: [] });
    expect(await json(await web('GET', '/admin/team/people', cFulana))).toEqual({ people: [] });
    const r = await json(await web('GET', '/admin/team/people?q=BELTR', cFulana));
    expect(r.people).toEqual([{ userId: beltrano, name: 'Beltrano', email: 'beltrano@ufba.br', roles: [] }]);
    const byMail = await json(await web('GET', '/admin/team/people?q=fulana@', cFulana));
    expect(byMail.people.map((x: any) => x.userId)).toEqual([fulana]);
  });

  it('atribuir dá escrita nos três; retirar volta para a base de todo estudante: ler a documentação', async () => {
    expect((await web('PUT', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana)).status).toBe(204);
    expect(grantsOfBeltrano()).toEqual(['ufba-app/api:write', 'ufba-app/docs:write', 'ufba-app/web:write']);
    expect([...fake.projects.keys()].sort()).toEqual(['ufba-app/api', 'ufba-app/docs', 'ufba-app/web']);
    const t = await json(await web('GET', '/admin/team', cFulana));
    expect(t.members).toEqual([{ userId: beltrano, name: 'Beltrano', email: 'beltrano@ufba.br', roles: ['maintainer'] }]);
    const mine = (await json(await web('GET', '/memory/projects', cBeltrano))).projects;
    expect(mine).toHaveLength(3);
    expect(mine.every((p: any) => p.team && p.source === 'team')).toBe(true);

    await web('DELETE', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana);
    expect(grantsOfBeltrano()).toEqual(['ufba-app/docs:read']); // a base de todo mundo
    const after = (await json(await web('GET', '/memory/projects', cBeltrano))).projects;
    expect(after.map((p: any) => `${p.workspace}/${p.project}:${p.role}`)).toEqual(['ufba-app/docs:read']);
    expect((await json(await web('GET', '/admin/team', cFulana))).members).toEqual([]);
  });

  it('papel inexistente e pessoa inexistente dão 404; atribuir duas vezes é inofensivo', async () => {
    const r = await web('PUT', `/admin/team/members/${beltrano}/roles/chefe`, cFulana);
    expect(r.status).toBe(404);
    expect((await json(r)).error).toBe('role_not_found');
    expect((await web('PUT', '/admin/team/members/ninguem/roles/maintainer', cFulana)).status).toBe(404);
    await web('PUT', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana);
    expect((await web('PUT', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana)).status).toBe(204);
    expect(roles.assignments).toHaveLength(1);
    await web('DELETE', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana);
  });

  it('fila de sincronização: falhas (só código) e projetos desconhecidos no memory', async () => {
    await web('PUT', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana); // garante usuário no memory
    await fake.stop();
    const down = await web('DELETE', `/admin/team/members/${beltrano}/roles/maintainer`, cFulana);
    expect(down.status).toBe(204); // retirado; a revisão do acesso fica pendente
    fake = new FakeAiMemory(ROOT);
    const back = await fake.start();
    void back;
    const s = await json(await web('GET', '/admin/memory/sync', cFulana));
    expect(s.failing).toHaveLength(1);
    expect(s.failing[0]).toMatchObject({ email: 'beltrano@ufba.br', attempts: 1, lastError: 'unavailable' });
    expect(JSON.stringify(s)).not.toMatch(/aim_|CANARIO/);
  });
});
