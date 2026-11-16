import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OpenMemoryAccess, SeededProjectRegistry } from '../src/application/memory/memory-defaults';
import { MemoryComputers } from '../src/application/memory/memory-computers';
import { MemoryUserRecord, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { MemoryProxy } from '../src/application/memory/memory-proxy';
import { withTypes } from '../src/application/memory/memory-tool-meta';
import { MemoryUsers } from '../src/application/memory/memory-users';
import type { EncryptedSecret } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import type { McpClinica, McpUseCases } from '../src/interface/mcp/mcp-ports';
import { buildMcpServer } from '../src/interface/mcp/mcp-tools';
import { InMemoryComputerRepo } from './support/memory-fakes';

const ROOT = 'root-token-store-compliance-01';
const UID = '01a1db61-e0d4-7261-ae1d-0b563922fde5';

class Repo extends MemoryUserRepository {
  rows = new Map<string, MemoryUserRecord>();
  async find(userId: string) {
    return this.rows.get(userId) ?? null;
  }
  async createIfAbsent(i: { userId: string; memoryUsername: string }) {
    const row: MemoryUserRecord = this.rows.get(i.userId) ?? {
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
  async saveProxyIfAbsent(userId: string, i: { credentialId: string; key: EncryptedSecret; displayName: string | null }) {
    const row = this.rows.get(userId)!;
    if (row.proxyCredentialId) return false;
    Object.assign(row, { proxyCredentialId: i.credentialId, proxyKey: i.key, displayName: i.displayName });
    return true;
  }
  async markReady(userId: string) {
    this.rows.get(userId)!.status = 'ready';
  }
}

type Tool = { name: string; title?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

const COMBINATORS = ['anyOf', 'oneOf', 'allOf'];

/** Todo sub-schema sem `type` (e sem `$ref`/combinador) que o validador da loja acharia. */
function untyped(schema: unknown, path: string, out: string[] = []): string[] {
  if (typeof schema !== 'object' || schema === null) return out;
  const s = schema as Record<string, unknown>;
  // `type` no PRÓPRIO nível, mesmo com anyOf/oneOf/$ref (é o que o validador da loja exige).
  if (s.type === undefined) out.push(path);
  for (const k of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const m = s[k];
    if (m && typeof m === 'object') for (const [n, sub] of Object.entries(m)) untyped(sub, `${path}.${n}`, out);
  }
  for (const k of ['items', 'additionalProperties', 'not']) if (typeof s[k] === 'object') untyped(s[k], `${path}.${k}`, out);
  for (const k of COMBINATORS) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach((x, i) => untyped(x, `${path}.${k}[${i}]`, out));
  return out;
}

describe('exigências da loja do Claude: todas as ferramentas do /mcp', () => {
  let fake: FakeAiMemory;
  let tools: Tool[];
  let instructions: string | undefined;

  beforeAll(async () => {
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    const admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    const users = new MemoryUsers(admin, new Repo(), new AesSecretCipher(Buffer.alloc(32, 5).toString('base64')));
    const computers = new MemoryComputers(admin, users, new InMemoryComputerRepo(), () => 1);
    const proxy = new MemoryProxy(admin, users, new MemoryMcpClient({ baseUrl: url }), new SeededProjectRegistry(), new OpenMemoryAccess(), computers);
    // Com SIASB: entram também as clinica_*; sem clientName: entra memory_connect_computer.
    const server = buildMcpServer({} as McpUseCases, { userId: UID, siasb: true }, proxy, {} as McpClinica);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    tools = (await client.listTools()).tools as Tool[];
    instructions = client.getInstructions();
  });
  afterAll(() => fake.stop());

  it('as instruções do servidor mandam usar o conector em contexto acadêmico mesmo sem dizer UFBA', () => {
    expect(instructions).toContain('MESMO que ela não');
    for (const w of ['prova', 'prazo', 'estudar', 'matéria']) expect(instructions).toContain(w);
    expect(instructions).toContain('memory_status');
  });

  it('o conjunto é o esperado (casa 7 + clinica 7 + memory 20)', () => {
    expect(tools).toHaveLength(34);
    expect(new Set(tools.map((t) => t.name)).size).toBe(34);
  });

  it('toda propriedade de todo inputSchema tem type (inclusive aninhadas)', () => {
    const faltando = tools.flatMap((t) => untyped(t.inputSchema, t.name));
    expect(faltando).toEqual([]);
  });

  it('toda ferramenta tem title e annotations com readOnlyHint e destructiveHint', () => {
    for (const t of tools) {
      expect(typeof t.title).toBe('string');
      expect(t.title!.length).toBeGreaterThan(2);
      expect(typeof t.annotations?.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations?.destructiveHint).toBe('boolean');
      if (t.annotations!.readOnlyHint) expect(t.annotations!.destructiveHint).toBe(false);
    }
  });

  it('annotations.title também, nas 34', () => {
    for (const t of tools) expect((t.annotations as { title?: string }).title).toBe(t.title);
  });

  it('Option<enum> do ai-memory (anyOf/oneOf com null, $ref): memory_feedback.signal e memory_message_send.nature têm type no nível da propriedade', () => {
    const props = (n: string) => (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, any> }).properties;
    expect(props('memory_feedback').signal.type).toEqual(['string', 'null']);
    expect(props('memory_feedback').signal.anyOf).toBeDefined();
    expect(props('memory_message_send').nature.type).toEqual(['string', 'null']);
    expect(props('memory_message_send').nature2.type).toEqual(['string', 'null']);
    expect(props('memory_message_send').nature3.type).toBe('string');
    expect(props('memory_message_send').nature4.type).toBe('string');
    expect(props('memory_message_send').nature5.type).toEqual(['string', 'null']);
  });

  it('as acadêmicas, clinica_* e a leitura de memória são somente leitura', () => {
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    const esperadas = [
      'listar_contas', 'listar_cursos', 'prazos', 'ver_curso', 'ver_forum', 'ver_aviso', 'baixar_anexo',
      'clinica_situacao', 'clinica_sessoes', 'clinica_prazo_marcacao', 'clinica_pacientes', 'clinica_vagas',
      'clinica_contexto_agendamento', 'clinica_progresso',
      'memory_status', 'memory_connect_computer', 'memory_briefing', 'memory_explore', 'memory_handoff_list',
      'memory_message_list', 'memory_query', 'memory_read_page', 'memory_read_session_observations', 'memory_recent',
      'memory_resolve_write_target',
    ];
    for (const n of esperadas) expect(readOnly).toContain(n);
    expect(readOnly).toHaveLength(esperadas.length);
  });

  it('as que gravam não são somente leitura; pop, lote e sobrescrita são destrutivas; só as que acrescentam não são', () => {
    const by = (n: string) => tools.find((t) => t.name === n)!.annotations!;
    for (const n of ['memory_message_pop', 'memory_write_pages_batch', 'memory_write_page', 'memory_patch_page', 'memory_consolidate']) {
      expect(by(n)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const n of ['memory_handoff_begin', 'memory_handoff_accept', 'memory_message_send', 'memory_feedback']) {
      expect(by(n)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('as anotações do servidor remoto não valem: memory_install_self_routing (que se declara somente leitura) nem é repassada', () => {
    expect(tools.map((t) => t.name)).not.toContain('memory_install_self_routing');
  });

  it('a normalização dá type coerente, não altera o que já tem e não muta a entrada', () => {
    const input = {
      type: 'object',
      properties: {
        signal: { enum: ['a', 'b'] },
        n: { const: 3 },
        flag: { enum: [true, false] },
        lista: { items: { enum: ['x'] } },
        obj: { properties: { de: {} } },
        livre: {},
        ok: { type: 'integer' },
        ref: { $ref: '#/$defs/x' },
        uniao: { anyOf: [{ enum: ['x'] }, { type: 'number' }] },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = withTypes(input) as { properties: Record<string, any> };
    expect(input).toEqual(snapshot);
    const p = out.properties;
    expect(p.signal.type).toBe('string');
    expect(p.n.type).toBe('integer');
    expect(p.flag.type).toBe('boolean');
    expect(p.lista.type).toBe('array');
    expect(p.lista.items.type).toBe('string');
    expect(p.obj.type).toBe('object');
    expect(p.obj.properties.de.type).toBe('string');
    expect(p.livre.type).toBe('string');
    expect(p.ok.type).toBe('integer');
    expect(p.ref.type).toBe('string');
    expect(p.uniao.type).toEqual(['string', 'number']);
    expect(p.uniao.anyOf[0].type).toBe('string');
  });
});

describe('exigências da loja: as quatro ferramentas de escrita do SIASB (principal com as duas chaves)', () => {
  const noop = async () => {
    throw new Error('não chamado');
  };
  const clinica = { writes: () => ({ scheduleSession: noop, unscheduleSession: noop, addProcedure: noop, removeProcedure: noop }) } as unknown as McpClinica;
  let tools: Tool[];

  beforeAll(async () => {
    const p = { userId: UID, siasb: true, permissions: new Set(['siasb.schedule_write', 'siasb.procedures_write']) };
    const server = buildMcpServer({} as McpUseCases, p, undefined, clinica);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    tools = (await client.listTools()).tools as Tool[];
  });

  it('as quatro entram, com type em toda propriedade, title e annotations coerentes', () => {
    const w = tools.filter((t) => /^clinica_(agendar|desmarcar|incluir|excluir)_/.test(t.name));
    expect(w.map((t) => t.name).sort()).toEqual([
      'clinica_agendar_sessao',
      'clinica_desmarcar_sessao',
      'clinica_excluir_procedimento',
      'clinica_incluir_procedimento',
    ]);
    expect(tools.flatMap((t) => untyped(t.inputSchema, t.name))).toEqual([]);
    for (const t of w) {
      expect(t.title!.length).toBeGreaterThan(2);
      expect((t.annotations as { title?: string }).title).toBe(t.title);
      expect(t.annotations!.readOnlyHint).toBe(false);
      expect(typeof t.annotations!.destructiveHint).toBe('boolean');
    }
  });
});
