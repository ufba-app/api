import { GrantReconciler, backoffMs } from '../src/application/memory/grant-reconciler';
import { MemoryComputers } from '../src/application/memory/memory-computers';
import { EX_PARTICIPANT, MemoryDeparture } from '../src/application/memory/memory-departure';
import { MemoryMaintenance } from '../src/application/memory/memory-maintenance';
import { MemoryProjects, slugOf, UserLookup } from '../src/application/memory/memory-projects';
import { MemoryUsers } from '../src/application/memory/memory-users';
import { DbProjectRegistry } from '../src/application/memory/memory-defaults';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import {
  InMemoryComputerRepo,
  InMemoryProjectRepo,
  InMemorySyncJobRepo,
  InMemoryUserRepo,
  StubTeamGrants,
} from './support/memory-fakes';

const ROOT = 'root-token-projects-0006';
const FULANA = 'u-aaaaaaaaaaaa';
const BELTRANO = 'u-bbbbbbbbbbbb';
const CICLANA = 'u-cccccccccccc';
const PEOPLE: Record<string, { email: string; name: string }> = {
  [FULANA]: { email: 'fulana@ufba.br', name: 'Fulana' },
  [BELTRANO]: { email: 'beltrano@ufba.br', name: 'Beltrano' },
  [CICLANA]: { email: 'ciclana@ufba.br', name: 'Ciclana' },
};
const unameOf = (id: string) => `u${id.replace(/-/g, '').slice(-12)}`;

describe('Meus projetos, reconciliador e saída da conta (contra o fake do ai-memory)', () => {
  let fake: FakeAiMemory;
  let clock: number;
  let existing: Set<string>;
  let projects: InMemoryProjectRepo;
  let jobs: InMemorySyncJobRepo;
  let team: StubTeamGrants;
  let users: MemoryUsers;
  let computers: MemoryComputers;
  let reconciler: GrantReconciler;
  let svc: MemoryProjects;
  let departure: MemoryDeparture;
  let admin: MemoryAdminClient;

  const directory: UserLookup = {
    findByEmail: async (email) => {
      const id = Object.keys(PEOPLE).find((k) => PEOPLE[k].email === email && existing.has(k));
      return id ? { id } : null;
    },
    findProfile: async (id) => (existing.has(id) && PEOPLE[id] ? { id, ...PEOPLE[id] } : null),
  };

  beforeEach(async () => {
    clock = 1_000_000_000_000;
    existing = new Set([FULANA, BELTRANO]); // Ciclana ainda não tem conta
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    users = new MemoryUsers(admin, new InMemoryUserRepo(), new AesSecretCipher(Buffer.alloc(32, 4).toString('base64')), async (id) => PEOPLE[id]?.name ?? null);
    projects = new InMemoryProjectRepo();
    jobs = new InMemorySyncJobRepo();
    team = new StubTeamGrants();
    computers = new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => clock);
    reconciler = new GrantReconciler({
      admin,
      users,
      projects,
      jobs,
      team,
      emailOf: async (id) => (existing.has(id) ? (PEOPLE[id]?.email ?? null) : null),
      now: () => clock,
    });
    svc = new MemoryProjects({ projects, jobs, reconciler, admin, users, directory, domain: 'ufba.br', now: () => clock });
    departure = new MemoryDeparture(admin, users, computers, projects, svc, reconciler);
  });
  afterEach(() => fake.stop());

  const grantsOf = (id: string) => fake.grants.filter((g) => g.username === unameOf(id)).map((g) => `${g.workspace}/${g.project}:${g.level}`);
  const only = async (id: string) => (await svc.list(id))[0];

  it('slug: sem acento, minúsculo, só letras/números/hífen', () => {
    expect(slugOf('Meu TCC: Grafos & Árvores!')).toBe('meu-tcc-grafos-arvores');
    expect(slugOf('  ')).toBe('projeto');
    expect(slugOf('x'.repeat(80))).toHaveLength(30);
  });

  describe('criar', () => {
    it('cria restrito no memory, com identificador estável <slug>-<4 hex> e write para a dona', async () => {
      const p = await svc.create(FULANA, 'Meu TCC');
      expect(p).toMatchObject({ workspace: 'ufba-alunos', title: 'Meu TCC', team: false, role: 'owner', source: 'owner', membersCount: 1, sync: 'ok' });
      expect(p.project).toMatch(/^meu-tcc-[0-9a-f]{4}$/);
      expect(fake.projects.has(`ufba-alunos/${p.project}`)).toBe(true);
      expect(grantsOf(FULANA)).toEqual([`ufba-alunos/${p.project}:write`]);
      expect((await svc.list(FULANA)).map((x) => x.id)).toEqual([p.id]);
      expect(await svc.list(BELTRANO)).toEqual([]);
      expect(await new DbProjectRegistry(projects).isRegistered('ufba-alunos', p.project)).toBe(true);
      expect(await new DbProjectRegistry(projects).isRegistered('ufba-alunos', 'outro')).toBe(false);
    });

    it('nome repetido da mesma pessoa é recusado; de outra pessoa pode', async () => {
      await svc.create(FULANA, 'Meu TCC');
      await expect(svc.create(FULANA, 'meu tcc')).rejects.toMatchObject({ code: 'project_name_taken', status: 409 });
      await expect(svc.create(BELTRANO, 'Meu TCC')).resolves.toBeDefined();
      await expect(svc.create(FULANA, '   ')).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('memory fora do ar: o projeto nasce e fica "sincronizando", com tentativa agendada em backoff', async () => {
      await fake.stop();
      const p = await svc.create(FULANA, 'Offline');
      expect(p.sync).toBe('pending');
      const job = jobs.jobs.get(FULANA)!;
      expect(job).toMatchObject({ attempts: 1, lastError: 'unavailable' });
      expect(job.nextRunAt.getTime()).toBe(clock + backoffMs(1));
      expect(backoffMs(1)).toBe(30_000);
      expect(backoffMs(2)).toBe(60_000);
      expect(backoffMs(30)).toBe(30 * 60_000);
      fake = new FakeAiMemory(ROOT);
    });

    it('a retentativa vencida sincroniza e limpa o job', async () => {
      await fake.stop();
      const p = await svc.create(FULANA, 'Depois');
            expect(p.sync).toBe('pending');
      // o memory volta (nova instância na mesma porta não é possível: troca o cliente)
      fake = new FakeAiMemory(ROOT);
      const back = await fake.start();
      const admin2 = new MemoryAdminClient({ baseUrl: back, rootToken: Secret.of(ROOT) });
      const users2 = new MemoryUsers(admin2, new InMemoryUserRepo(), new AesSecretCipher(Buffer.alloc(32, 4).toString('base64')), async (id) => PEOPLE[id]?.name ?? null);
      const rec2 = new GrantReconciler({ admin: admin2, users: users2, projects, jobs, team, emailOf: async (id) => PEOPLE[id]?.email ?? null, now: () => clock });
      expect(await rec2.runDue()).toBe(0); // ainda não venceu
      clock += 31_000;
      expect(await rec2.runDue()).toBe(1);
      expect(jobs.jobs.size).toBe(0);
      expect(fake.grants).toHaveLength(1);
    });
  });

  describe('convites e níveis', () => {
    it('convida com leitura, muda para escrita, remove: o grant acompanha a cada passo', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'Beltrano@UFBA.br ', 'read');
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${p.project}:read`]);
      expect((await only(BELTRANO))).toMatchObject({ role: 'read', source: 'invite', team: false, membersCount: 2 });
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'write');
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${p.project}:write`]);
      await svc.removeMember(FULANA, p.id, 'beltrano@ufba.br');
      expect(grantsOf(BELTRANO)).toEqual([]);
      expect(await svc.list(BELTRANO)).toEqual([]);
    });

    it('só e-mail @ufba.br; o dono não se convida; só o dono convida', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      for (const bad of ['alguem@gmail.com', 'sem-arroba', 'x@ufba.br.evil.com', 'x@fake-ufba.br']) {
        await expect(svc.setMember(FULANA, p.id, bad, 'read')).rejects.toMatchObject({ code: 'invalid_email_domain', status: 400 });
      }
      await expect(svc.setMember(FULANA, p.id, 'fulana@ufba.br', 'read')).rejects.toMatchObject({ code: 'invalid_request' });
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'write');
      await expect(svc.setMember(BELTRANO, p.id, 'ciclana@ufba.br', 'read')).rejects.toMatchObject({ code: 'not_project_owner', status: 403 });
      await expect(svc.setMember(CICLANA, p.id, 'x@ufba.br', 'read')).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
    });

    it('convite a quem ainda não tem conta fica pendente e vale no primeiro uso', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'ciclana@ufba.br', 'read');
      expect(projects.members[0]).toMatchObject({ status: 'pending', userId: null });
      expect(grantsOf(CICLANA)).toEqual([]);
      const detail = await svc.detail(FULANA, p.id);
      expect(detail.members).toEqual([{ email: 'ciclana@ufba.br', name: null, level: 'read', status: 'pending' }]);
      expect(detail.membersCount).toBe(1); // pendente não conta
      existing.add(CICLANA); // primeiro login
      expect(await reconciler.syncUser(CICLANA)).toBe(true);
      expect(grantsOf(CICLANA)).toEqual([`ufba-alunos/${p.project}:read`]);
      expect(projects.members[0]).toMatchObject({ status: 'active', userId: CICLANA });
    });

    it('nível efetivo = o MAIOR entre convite e papel; tirar um não revoga o que o outro sustenta', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      team.grants.set(BELTRANO, [{ projectId: p.id, level: 'write' }]);
      expect(await reconciler.syncUser(BELTRANO)).toBe(true);
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${p.project}:write`]);
      expect(await only(BELTRANO)).toMatchObject({ role: 'write', source: 'team' });
      team.grants.delete(BELTRANO);
      await reconciler.syncUser(BELTRANO);
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${p.project}:read`]); // convite continua
      await svc.removeMember(FULANA, p.id, 'beltrano@ufba.br');
      expect(grantsOf(BELTRANO)).toEqual([]);
    });

    it('membro sai sozinho; o dono não sai sem transferir; outro membro não remove ninguém', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'write');
      existing.add(CICLANA);
      await svc.setMember(FULANA, p.id, 'ciclana@ufba.br', 'read');
      await expect(svc.removeMember(BELTRANO, p.id, 'ciclana@ufba.br')).rejects.toMatchObject({ code: 'not_project_owner' });
      await expect(svc.removeMember(FULANA, p.id, 'fulana@ufba.br')).rejects.toMatchObject({ code: 'invalid_request' });
      await svc.removeMember(BELTRANO, p.id, 'beltrano@ufba.br'); // sair
      expect(grantsOf(BELTRANO)).toEqual([]);
      expect(grantsOf(CICLANA)).toHaveLength(1);
    });

    it('o reconciliador só mexe em projetos gerenciados: grant de projeto desconhecido fica como está', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await admin.grant(unameOf(FULANA), 'outro-ws', 'de-fora', 'write');
      await reconciler.syncUser(FULANA);
      expect(grantsOf(FULANA).sort()).toEqual(['outro-ws/de-fora:write', `ufba-alunos/${p.project}:write`]);
    });

    it('divergência no memory é corrigida (grant a mais é revogado, a menos é concedido, nível errado é trocado)', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      const q = await svc.create(FULANA, 'Outro');
      await admin.revokeGrant(unameOf(FULANA), 'ufba-alunos', p.project); // faltando
      await admin.grant(unameOf(FULANA), 'ufba-alunos', q.project, 'read'); // nível errado
      await svc.setMember(FULANA, q.id, 'beltrano@ufba.br', 'read');
      await svc.removeMember(FULANA, q.id, 'beltrano@ufba.br');
      await admin.grant(unameOf(BELTRANO), 'ufba-alunos', p.project, 'write'); // sobrando
      await reconciler.syncUser(FULANA);
      await reconciler.syncUser(BELTRANO);
      expect(grantsOf(FULANA).sort()).toEqual([`ufba-alunos/${p.project}:write`, `ufba-alunos/${q.project}:write`].sort());
      expect(grantsOf(BELTRANO)).toEqual([]);
    });
  });

  describe('detalhe, transferência e exclusão', () => {
    it('detalhe: dono vê membros e o marcador; convidado vê só o resumo', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      const dono = await svc.detail(FULANA, p.id);
      expect(dono.members).toEqual([{ email: 'beltrano@ufba.br', name: 'Beltrano', level: 'read', status: 'active' }]);
      expect(dono.marker).toBe(`workspace = "ufba-alunos"\nproject   = "${p.project}"\nserver    = "ufba"`);
      const conv = await svc.detail(BELTRANO, p.id);
      expect(conv.members).toEqual([]);
      expect(conv.role).toBe('read');
      await expect(svc.detail(CICLANA, p.id)).rejects.toMatchObject({ code: 'project_not_found' });
    });

    it('transferir: só para membro ativo com escrita; quem transferiu continua com escrita', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      await expect(svc.transfer(FULANA, p.id, 'beltrano@ufba.br')).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(svc.transfer(FULANA, p.id, 'ciclana@ufba.br')).rejects.toMatchObject({ code: 'invalid_request' });
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'write');
      await svc.transfer(FULANA, p.id, 'beltrano@ufba.br');
      expect(projects.projects.get(p.id)!.ownerId).toBe(BELTRANO);
      expect(await only(BELTRANO)).toMatchObject({ role: 'owner' });
      expect(await only(FULANA)).toMatchObject({ role: 'write', source: 'invite' });
      expect(grantsOf(FULANA)).toEqual([`ufba-alunos/${p.project}:write`]);
      await expect(svc.setMember(FULANA, p.id, 'x@ufba.br', 'read')).rejects.toMatchObject({ code: 'not_project_owner' });
    });

    it('apagar: some no memory (grants e conteúdo) e aqui; só o dono; memory fora do ar não apaga nada', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      await expect(svc.remove(BELTRANO, p.id)).rejects.toMatchObject({ code: 'not_project_owner' });
      await svc.remove(FULANA, p.id);
      expect(fake.projects.has(`ufba-alunos/${p.project}`)).toBe(false);
      expect(grantsOf(FULANA)).toEqual([]);
      expect(grantsOf(BELTRANO)).toEqual([]);
      expect(projects.projects.size).toBe(0);
      expect(projects.members).toEqual([]);

      const q = await svc.create(FULANA, 'Outro');
      await fake.stop();
      await expect(svc.remove(FULANA, q.id)).rejects.toMatchObject({ code: 'memory_unavailable', status: 503 });
      expect(projects.projects.has(q.id)).toBe(true);
      fake = new FakeAiMemory(ROOT);
    });
  });

  describe('projetos do time e S12', () => {
    it('projetos do time existem no memory como restritos antes de qualquer pessoa; desconhecidos nos ufba-* são apontados', async () => {
      for (const n of ['api', 'web', 'docs']) {
        await projects.insert({ id: `t-${n}`, workspace: 'ufba-app', project: n, title: n, ownerId: null, createdAt: new Date(clock) });
      }
      await reconciler.ensureTeamProjects();
      expect([...fake.projects.keys()].sort()).toEqual(['ufba-app/api', 'ufba-app/docs', 'ufba-app/web']);
      expect(fake.users).toHaveLength(0); // ninguém foi criado só por isso
      await admin.setProjectAccess('ufba-app', 'clandestino', 'restricted');
      await admin.setProjectAccess('ufba-alunos', 'sorrateiro-1234', 'restricted');
      await admin.setProjectAccess('pessoal', 'meu-repo', 'restricted'); // fora dos ufba-*: não é problema nosso
      expect((await reconciler.unknownProjects()).map((x) => `${x.workspace}/${x.project}`).sort()).toEqual(['ufba-alunos/sorrateiro-1234', 'ufba-app/clandestino']);
    });

    it('papel do time vira grant e some quando o papel some', async () => {
      await projects.insert({ id: 't-api', workspace: 'ufba-app', project: 'api', title: 'API', ownerId: null, createdAt: new Date(clock) });
      team.grants.set(BELTRANO, [{ projectId: 't-api', level: 'write' }]);
      await reconciler.syncUser(BELTRANO);
      expect(grantsOf(BELTRANO)).toEqual(['ufba-app/api:write']);
      expect(await only(BELTRANO)).toMatchObject({ team: true, role: 'write', source: 'team', membersCount: 0 });
      team.grants.clear();
      await reconciler.syncUser(BELTRANO);
      expect(grantsOf(BELTRANO)).toEqual([]);
    });
  });

  describe('saída da conta (DELETE /me)', () => {
    const setup = async () => {
      // Fulana: um projeto só dela, um compartilhado (Beltrano escrita desde antes, Ciclana leitura) e dois computadores.
      existing.add(CICLANA);
      const solo = await svc.create(FULANA, 'So eu');
      const shared = await svc.create(FULANA, 'Compartilhado');
      await svc.setMember(FULANA, shared.id, 'ciclana@ufba.br', 'read');
      clock += 1000;
      await svc.setMember(FULANA, shared.id, 'beltrano@ufba.br', 'write');
      const a = await computers.create(FULANA, { name: 'a', os: 'linux' });
      const b = await computers.create(FULANA, { name: 'b', os: 'windows' });
      await computers.confirm(FULANA, a.computerId);
      await computers.confirm(FULANA, b.computerId);
      return { solo, shared, a, b };
    };

    it('ordem do desenho: chaves revogadas, pessoal apagado, compartilhado entregue, usuário desativado e sem nome', async () => {
      const { solo, shared, a, b } = await setup();
      const proxyKey = (await users.proxyKey(FULANA)).reveal();
      await departure.run(FULANA);

      for (const key of [a.key.reveal(), b.key.reveal(), proxyKey]) expect(fake.authenticate(key)).toBeNull();
      expect(fake.projects.has(`ufba-alunos/${solo.project}`)).toBe(false);
      expect(projects.projects.has(solo.id)).toBe(false);

      // o conteúdo do compartilhado fica; a posse vai para quem tem escrita (Beltrano), não para a mais antiga (Ciclana, leitura)
      expect(projects.projects.get(shared.id)!.ownerId).toBe(BELTRANO);
      expect(fake.projects.has(`ufba-alunos/${shared.project}`)).toBe(true);
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${shared.project}:write`]);
      expect(grantsOf(CICLANA)).toEqual([`ufba-alunos/${shared.project}:read`]);
      expect(grantsOf(FULANA)).toEqual([]);
      expect(projects.members.some((m) => m.userId === FULANA)).toBe(false);

      const me = fake.users.find((u) => u.username === unameOf(FULANA))!;
      expect(me.name).toBe(EX_PARTICIPANT);
      expect(me.disabled_at).not.toBeNull();
      expect(fake.users.find((u) => u.username === unameOf(BELTRANO))!.disabled_at).toBeNull();
    });

    it('sem membro com escrita, herda o membro ativo mais antigo; sem ninguém, o projeto some', async () => {
      const p = await svc.create(FULANA, 'So leitura');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      await departure.run(FULANA);
      expect(projects.projects.get(p.id)!.ownerId).toBe(BELTRANO);
      expect(await only(BELTRANO)).toMatchObject({ role: 'owner' });
    });

    it('memory fora do ar: a exclusão é interrompida (503) e pode ser repetida sem estrago', async () => {
      await setup();
      await fake.stop();
      await expect(departure.run(FULANA)).rejects.toMatchObject({ code: 'memory_unavailable', status: 503 });
      expect(projects.projects.size).toBe(2); // nada apagado do lado de cá enquanto o memory não respondeu
      fake = new FakeAiMemory(ROOT);
    });

    it('é idempotente: rodar de novo depois de concluída não falha nem desfaz nada', async () => {
      await setup();
      await departure.run(FULANA);
      await expect(departure.run(FULANA)).resolves.toBeUndefined();
      expect(fake.users.filter((u) => u.disabled_at).map((u) => u.username)).toEqual([unameOf(FULANA)]);
    });

    it('pessoa que nunca usou a memória: nada a fazer, sem criar usuário', async () => {
      await expect(departure.run(BELTRANO)).resolves.toBeUndefined();
      expect(fake.users).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
    });

    it('sem memory configurado, só a parte do banco roda (projetos entregues/apagados)', async () => {
      const off = new MemoryAdminClient({ baseUrl: fakeUrl(fake) });
      const dep = new MemoryDeparture(off, users, computers, projects, svc, reconciler);
      await projects.insert({ id: 'solo', workspace: 'ufba-alunos', project: 'solo-aaaa', title: 's', ownerId: BELTRANO, createdAt: new Date(clock) });
      await expect(dep.run(BELTRANO)).resolves.toBeUndefined();
      expect(projects.projects.has('solo')).toBe(false);
    });
  });

  describe('varredura periódica', () => {
    it('garante projetos do time, revoga chave não confirmada, retenta jobs e reconcilia quem tem acesso', async () => {
      await projects.insert({ id: 't-api', workspace: 'ufba-app', project: 'api', title: 'API', ownerId: null, createdAt: new Date(clock) });
      const p = await svc.create(FULANA, 'Grupo');
      await svc.setMember(FULANA, p.id, 'beltrano@ufba.br', 'read');
      const lost = await computers.create(FULANA, { name: 'perdido', os: 'linux' });
      clock += 11 * 60_000;
      await admin.revokeGrant(unameOf(BELTRANO), 'ufba-alunos', p.project); // divergência
      await admin.setProjectAccess('ufba-app', 'clandestino', 'restricted');

      const report = await new MemoryMaintenance(reconciler, computers).run();
      expect(report).toMatchObject({ sweptComputers: 1, failed: 0, unknownProjects: 1 });
      expect(report.reconciled).toBeGreaterThanOrEqual(2);
      expect(fake.projects.has('ufba-app/api')).toBe(true);
      expect(fake.authenticate(lost.key.reveal())).toBeNull();
      expect(grantsOf(BELTRANO)).toEqual([`ufba-alunos/${p.project}:read`]);
    });

    it('com o memory fora do ar não explode: conta falhas e deixa jobs para depois', async () => {
      const p = await svc.create(FULANA, 'Grupo');
      void p;
      await fake.stop();
      const report = await new MemoryMaintenance(reconciler, computers).run();
      expect(report.failed).toBe(1);
      expect(jobs.jobs.has(FULANA)).toBe(true);
      fake = new FakeAiMemory(ROOT);
    });
  });
});

function fakeUrl(f: FakeAiMemory): string {
  void f;
  return 'http://127.0.0.1:9';
}
