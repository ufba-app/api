import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SeededProjectRegistry, OpenMemoryAccess } from '../src/application/memory/memory-defaults';
import { MemoryAccess, MemoryUserRecord, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { MEMORY_INSTRUCTIONS, MemoryProxy, CATALOG_TTL_MS } from '../src/application/memory/memory-proxy';
import { MEMORY_TOOL_CLASSES, classOf, unclassified } from '../src/application/memory/memory-tool-policy';
import { MemoryUsers } from '../src/application/memory/memory-users';
import type { EncryptedSecret } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FAKE_MEMORY_TOOLS, FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { FERRAMENTAS, buildMcpServer } from '../src/interface/mcp/mcp-tools';
import type { McpUseCases } from '../src/interface/mcp/mcp-ports';
import { MemoryComputers } from '../src/application/memory/memory-computers';
import { InMemoryComputerRepo, NoComputers } from './support/memory-fakes';

const ROOT = 'root-token-proxy-test-0003';
const UID = '01a1db61-e0d4-7261-ae1d-0b563922fde5';
const UID2 = '01a1db61-e0d4-7261-ae1d-aaaaaaaaaaaa';

class Repo extends MemoryUserRepository {
  rows = new Map<string, MemoryUserRecord>();
  async find(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async createIfAbsent(i: { userId: string; memoryUsername: string }) {
    const cur = this.rows.get(i.userId);
    if (cur) return cur;
    const row: MemoryUserRecord = {
      userId: i.userId,
      memoryUsername: i.memoryUsername,
      status: 'creating',
      proxyCredentialId: null,
      proxyKey: null,
      displayName: null,
    };
    this.rows.set(i.userId, row);
    return row;
  }
  async saveProxyIfAbsent(
    userId: string,
    i: { credentialId: string; key: EncryptedSecret; displayName: string | null },
  ) {
    const row = this.rows.get(userId)!;
    if (row.proxyCredentialId) return false;
    Object.assign(row, { proxyCredentialId: i.credentialId, proxyKey: i.key, displayName: i.displayName });
    return true;
  }
  async markReady(userId: string) {
    this.rows.get(userId)!.status = 'ready';
  }
}

const text = (r: { content: unknown[] } | null) => (r!.content[0] as { text: string }).text;

describe('política de ferramentas', () => {
  it('todas as 27 ferramentas da v3.4.6 estão classificadas (contrato: nome novo quebra aqui)', () => {
    expect(FAKE_MEMORY_TOOLS).toHaveLength(27);
    expect(unclassified(FAKE_MEMORY_TOOLS)).toEqual([]);
    expect(unclassified([...FAKE_MEMORY_TOOLS, 'memory_nova_ferramenta'])).toEqual(['memory_nova_ferramenta']);
  });

  it('só read e write passam; destrutivas, host e a memory_status do memory não', () => {
    const forwardable = Object.entries(MEMORY_TOOL_CLASSES).filter(([, c]) => c === 'read' || c === 'write');
    expect(forwardable).toHaveLength(18);
    for (const n of ['memory_delete_page', 'memory_forget_sweep', 'memory_install_self_routing', 'memory_lint']) {
      expect(['destructive', 'host']).toContain(classOf(n));
    }
    expect(classOf('memory_status')).toBe('house');
    expect(classOf('constructor')).toBeUndefined();
  });
});

describe('proxy de memória contra o fake do ai-memory', () => {
  let fake: FakeAiMemory;
  let url: string;
  let admin: MemoryAdminClient;
  let users: MemoryUsers;
  let proxy: MemoryProxy;
  let computers: MemoryComputers;
  let clock: number;

  const build = (access: MemoryAccess = new OpenMemoryAccess()) => {
    proxy = new MemoryProxy(admin, users, new MemoryMcpClient({ baseUrl: url }), new SeededProjectRegistry(), access, computers, {
      now: () => clock,
    });
  };

  beforeEach(async () => {
    clock = 1_000_000;
    fake = new FakeAiMemory(ROOT);
    url = await fake.start();
    admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    users = new MemoryUsers(admin, new Repo(), new AesSecretCipher(Buffer.alloc(32, 5).toString('base64')));
    computers = new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => clock);
    build();
  });
  afterEach(() => fake.stop());

  it('tools/list: memory_status da casa primeiro + só read/write do memory, sem duplicar memory_status', async () => {
    const names = (await proxy.listTools(UID)).map((t) => t.name);
    expect(names[0]).toBe('memory_status');
    expect(names.filter((n) => n === 'memory_status')).toHaveLength(1);
    expect(names).toHaveLength(19);
    for (const n of ['memory_delete_page', 'memory_forget_sweep', 'memory_install_self_routing', 'memory_lint']) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain('memory_query');
    expect(names).toContain('memory_write_page');
  });

  it('o catálogo fica em cache por 5 min e é buscado de novo depois', async () => {
    await proxy.listTools(UID);
    await proxy.listTools(UID2);
    expect(fake.mcpListCount).toBe(1);
    clock += CATALOG_TTL_MS + 1;
    await proxy.listTools(UID);
    expect(fake.mcpListCount).toBe(2);
  });

  it('versão nova do memory com ferramenta desconhecida: não aparece nem é chamada', async () => {
    fake.mcpTools.push('memory_nova_ferramenta');
    expect((await proxy.listTools(UID)).map((t) => t.name)).not.toContain('memory_nova_ferramenta');
    const r = await proxy.call(UID, 'memory_nova_ferramenta', { workspace: 'ufba-app', project: 'api' });
    expect(r!.isError).toBe(true);
    expect(fake.mcpCalls).toHaveLength(0);
  });

  it('repassa com a chave DA PESSOA e sem alterar argumentos nem resultado', async () => {
    const args = { workspace: 'ufba-app', project: 'api', path: 'notas/a.md', body: '# oi' };
    const r = await proxy.call(UID, 'memory_write_page', args);
    expect(r).toEqual({ content: [{ type: 'text', text: 'ok:memory_write_page' }] });
    expect(fake.mcpCalls).toEqual([{ username: 'u0b563922fde5', name: 'memory_write_page', args }]);
    await proxy.call(UID2, 'memory_query', { workspace: 'ufba-app', project: 'web' });
    expect(fake.mcpCalls[1].username).toBe('uaaaaaaaaaaaa');
  });

  it('bloqueia destrutivas e de host sem tocar o memory', async () => {
    for (const n of ['memory_delete_page', 'memory_forget_sweep', 'memory_install_self_routing', 'memory_auto_improve']) {
      const r = await proxy.call(UID, n, { workspace: 'ufba-app', project: 'api' });
      expect(r!.isError).toBe(true);
      expect(text(r)).toContain('não está disponível');
    }
    expect(fake.mcpCalls).toHaveLength(0);
  });

  it('exige workspace e project explícitos e registrados; recusa *_id', async () => {
    const bad: Record<string, unknown>[] = [
      {},
      { workspace: 'ufba-app' },
      { project: 'api' },
      { workspace: 'ufba-app', project: '' },
      { workspace: 7, project: 'api' },
      { workspace: 'ufba-app', project: 'api', project_id: 'x' },
      { workspace: 'ufba-app', project: 'api', workspace_id: 'x' },
      { workspace: 'ufba-alunos', project: 'proj-ab12' }, // não registrado (S12)
      { workspace: 'ufba-app', project: 'inventado' },
    ];
    for (const args of bad) {
      const r = await proxy.call(UID, 'memory_query', args);
      expect(r!.isError).toBe(true);
    }
    expect(fake.mcpCalls).toHaveLength(0);
    const good = await proxy.call(UID, 'memory_query', { workspace: 'ufba-app', project: 'docs' });
    expect(good!.isError).toBeUndefined();
  });

  it('erro do memory (sem permissão no projeto) volta como veio, legível', async () => {
    const r = await proxy.call(UID, 'memory_query', { workspace: 'ufba-app', project: 'forbidden' });
    // 'forbidden' não está registrado: o proxy barra antes e nem pergunta ao memory.
    expect(r!.isError).toBe(true);
    expect(fake.mcpCalls).toHaveLength(0);
    const reg = new SeededProjectRegistry([['ufba-app', 'forbidden']]);
    const p2 = new MemoryProxy(admin, users, new MemoryMcpClient({ baseUrl: url }), reg, new OpenMemoryAccess(), computers);
    const r2 = await p2.call(UID, 'memory_query', { workspace: 'ufba-app', project: 'forbidden' });
    expect(r2!.isError).toBe(true);
    expect(text(r2)).toContain('not authorized for ufba-app/forbidden');
  });

  it('limites: 1 MB por chamada e 30 por minuto por pessoa', async () => {
    const big = await proxy.call(UID, 'memory_write_page', {
      workspace: 'ufba-app',
      project: 'api',
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(big!.isError).toBe(true);
    expect(text(big)).toContain('1 MB');
    expect(fake.mcpCalls).toHaveLength(0);

    const q = { workspace: 'ufba-app', project: 'api' };
    for (let i = 0; i < 30; i++) expect((await proxy.call(UID, 'memory_query', q))!.isError).toBeUndefined();
    const over = await proxy.call(UID, 'memory_query', q);
    expect(over!.isError).toBe(true);
    expect(text(over)).toContain('30 por minuto');
    // outra pessoa não é afetada, e a janela libera depois de um minuto
    expect((await proxy.call(UID2, 'memory_query', q))!.isError).toBeUndefined();
    clock += 60_001;
    expect((await proxy.call(UID, 'memory_query', q))!.isError).toBeUndefined();
    expect(fake.mcpCalls.filter((c) => c.username === 'u0b563922fde5')).toHaveLength(31);
  });

  it('memory_status lê o servidor: nenhum computador, depois computadores conectados com último uso', async () => {
    const first = JSON.parse(text(await proxy.call(UID, 'memory_status', {}))) as Record<string, unknown>;
    expect(first).toMatchObject({ memory_available: true, user_ready: true, connected_computers: [] });
    expect(String(first.hint)).toContain('memory_connect_computer');

    const a = await computers.create(UID, { name: 'notebook da Fulana', os: 'windows' });
    const b = await computers.create(UID, { name: 'desktop', os: 'linux' });
    await computers.create(UID, { name: 'nunca confirmado', os: 'macos' });
    await computers.confirm(UID, a.computerId);
    await computers.confirm(UID, b.computerId);
    fake.authenticate(a.key.reveal());
    const next = JSON.parse(text(await proxy.call(UID, 'memory_status', {}))) as {
      connected_computers: { name: string; os: string; last_seen: string | null }[];
    };
    expect(next.connected_computers.map((c) => c.name).sort()).toEqual(['desktop', 'notebook da Fulana']);
    expect(next.connected_computers.find((c) => c.name === 'desktop')!.last_seen).toBeNull();
    expect(next.connected_computers.find((c) => c.name === 'desktop')!.os).toBe('linux');
    expect(next.connected_computers.find((c) => c.name === 'notebook da Fulana')!.last_seen).toMatch(/^\d{4}-/);
    // a chave de repasse (ufba-proxy) não é um computador
    expect(JSON.stringify(next)).not.toContain('ufba-proxy');
  });

  it('memory fora do ar: só memory_status (dizendo isso); chamadas viram erro fixo, sem vazar nada', async () => {
    await proxy.listTools(UID); // cria o usuário
    clock += CATALOG_TTL_MS + 1;
    await fake.stop();
    expect((await proxy.listTools(UID)).map((t) => t.name)).toEqual(['memory_status']);
    const r = await proxy.call(UID, 'memory_query', { workspace: 'ufba-app', project: 'api' });
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: expect.stringContaining('indisponível') }] });
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|aim_|root-token/);
    const st = JSON.parse(text(await proxy.call(UID, 'memory_status', {}))) as { memory_available: boolean };
    expect(st.memory_available).toBe(false);
    fake = new FakeAiMemory(ROOT);
  });

  it('sem token root: nada de memory_* e nenhuma chamada', async () => {
    const off = new MemoryAdminClient({ baseUrl: url });
    const p = new MemoryProxy(
      off,
      new MemoryUsers(off, new Repo(), new AesSecretCipher(Buffer.alloc(32, 5).toString('base64'))),
      new MemoryMcpClient({ baseUrl: url }),
      new SeededProjectRegistry(),
      new OpenMemoryAccess(),
      new NoComputers(),
    );
    expect(p.enabled()).toBe(false);
    expect(await p.listTools(UID)).toEqual([]);
    expect((await p.call(UID, 'memory_query', {}))!.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('quem não está liberado não vê nem usa (gancho da etapa 8); nem cria usuário', async () => {
    build({ canUse: async () => false });
    expect(await proxy.listTools(UID)).toEqual([]);
    const r = await proxy.call(UID, 'memory_query', { workspace: 'ufba-app', project: 'api' });
    expect(text(r)).toContain('não está liberada');
    expect(fake.users).toHaveLength(0);
  });

  it('nome que não é de memória volta null (segue para as ferramentas da casa)', async () => {
    expect(await proxy.call(UID, 'listar_cursos', {})).toBeNull();
  });
});

describe('/mcp com memória: ferramentas da casa + memory_*', () => {
  let fake: FakeAiMemory;
  let client: Client;

  const house = (): McpUseCases =>
    ({
      listarContas: jest.fn(async () => ({ contas: [] })),
      listarCursos: jest.fn(async () => ({ cursos: [{ id: '10' }] })),
    }) as unknown as McpUseCases;

  async function connect(enabled: boolean): Promise<Client> {
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    const admin = new MemoryAdminClient({ baseUrl: url, rootToken: enabled ? Secret.of(ROOT) : undefined });
    const users = new MemoryUsers(admin, new Repo(), new AesSecretCipher(Buffer.alloc(32, 5).toString('base64')));
    const proxy = new MemoryProxy(
      admin,
      users,
      new MemoryMcpClient({ baseUrl: url }),
      new SeededProjectRegistry(),
      new OpenMemoryAccess(),
      new NoComputers(),
    );
    const server = buildMcpServer(house(), { userId: UID }, proxy);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  }

  afterEach(() => fake.stop());

  it('lista as 7 da casa + memory_status + as do memory, e entrega as instructions', async () => {
    client = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const f of FERRAMENTAS) expect(names).toContain(f);
    expect(names).toContain('memory_status');
    expect(names).toContain('memory_query');
    expect(names).not.toContain('memory_delete_page');
    expect(names).toHaveLength(FERRAMENTAS.length + 19);
    expect(client.getInstructions()).toBe(MEMORY_INSTRUCTIONS);
    const q = (await client.listTools()).tools.find((t) => t.name === 'memory_query')!;
    expect(q.inputSchema.properties).toHaveProperty('workspace');
  });

  it('ferramenta da casa continua funcionando e a de memória passa pelo proxy', async () => {
    client = await connect(true);
    const casa = await client.callTool({ name: 'listar_cursos', arguments: {} });
    expect(casa.isError).toBeFalsy();
    expect(JSON.parse((casa.content as { text: string }[])[0].text)).toEqual({ cursos: [{ id: '10' }] });
    const mem = await client.callTool({ name: 'memory_query', arguments: { workspace: 'ufba-app', project: 'api' } });
    expect(mem.content).toEqual([{ type: 'text', text: 'ok:memory_query' }]);
    const bloqueada = await client.callTool({ name: 'memory_delete_page', arguments: {} });
    expect(bloqueada.isError).toBe(true);
    const status = await client.callTool({ name: 'memory_status', arguments: {} });
    expect(JSON.parse((status.content as { text: string }[])[0].text)).toMatchObject({ memory_available: true });
  });

  it('sem MEMORY_ROOT_TOKEN: só as ferramentas da casa e nada de instructions', async () => {
    client = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...FERRAMENTAS].sort());
    expect(client.getInstructions()).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });
});
