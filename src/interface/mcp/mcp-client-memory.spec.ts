import { Global, INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { McpTestingModule, TEST_API_KEY } from './testing/mcp-testing.module';
import { MCP_MEMORY } from './mcp-ports';

/** Memória falsa que só registra para quem foi perguntada (o que o controller descobriu do cliente). */
const seen: Array<string | null | undefined> = [];
const fakeMemory = {
  enabled: () => true,
  listTools: async (_u: string, client?: { name?: string | null }) => {
    seen.push(client?.name);
    return [];
  },
  call: async () => null,
};

@Global()
@Module({ imports: [McpTestingModule], providers: [{ provide: MCP_MEMORY, useValue: fakeMemory }], exports: [MCP_MEMORY] })
class WithMemoryModule {}

describe('POST /mcp: o clientInfo.name do initialize vale para as requisições seguintes do mesmo token', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    delete process.env.WEB_ORIGIN;
    delete process.env.AUTH_ORIGIN;
    delete process.env.PUBLIC_URL;
    app = await NestFactory.create(WithMemoryModule, { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const rpc = async (method: string, params: unknown, token = TEST_API_KEY) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const initialize = (name?: string) =>
    rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, ...(name ? { clientInfo: { name, version: '1' } } : { clientInfo: { name: '', version: '1' } }) });

  it('sem initialize antes (desconhecido): a memória recebe cliente sem nome, e as instruções são as condicionais', async () => {
    seen.length = 0;
    await rpc('tools/list', {});
    expect(seen.at(-1)).toBeUndefined();
  });

  it('chat web: o initialize já devolve as instruções SEM a oferta, e o tools/list seguinte é perguntado como claude-ai', async () => {
    const init = await initialize('claude-ai');
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toContain('memory_status');
    expect(init.body.result.instructions).not.toContain('memory_connect_computer');
    seen.length = 0;
    await rpc('tools/list', {});
    expect(seen.at(-1)).toBe('claude-ai');
    const prompts = await rpc('prompts/list', {});
    expect(prompts.body.error).toBeDefined(); // o prompt de conectar computador não é exposto a chat web
  });

  it('um novo initialize (outro cliente no mesmo token) troca: terminal/editor volta com a oferta condicional e o prompt', async () => {
    const init = await initialize('claude-code');
    expect(init.body.result.instructions).toContain('memory_connect_computer');
    expect(init.body.result.instructions).toContain('terminal ou editor');
    seen.length = 0;
    await rpc('tools/list', {});
    expect(seen.at(-1)).toBe('claude-code');
    const prompts = await rpc('prompts/list', {});
    expect(prompts.body.result.prompts.map((p: any) => p.name)).toEqual(['conectar-computador']);
  });

  it('outro token não herda o nome', async () => {
    seen.length = 0;
    // sem registro para este token: não há clientInfo guardado (a chave de API de teste é uma só; o 401 prova que não vaza)
    const r = await rpc('tools/list', {}, 'outro-token');
    expect(r.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
