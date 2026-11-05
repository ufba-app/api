import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpTestingModule, TEST_API_KEY } from './testing/mcp-testing.module';
import { buildMcpServer, FERRAMENTAS } from './mcp-tools';
import { McpUseCases } from './mcp-ports';

function fakeUseCases(): jest.Mocked<McpUseCases> {
  return {
    listarCursos: jest.fn(async () => ({ cursos: [{ id: '10', nome: 'Tópicos' }] })),
    prazos: jest.fn(async () => ({ prazos: [] })),
    verCurso: jest.fn(async () => ({ atividades: [] })),
    verForum: jest.fn(async () => ({ discussoes: [] })),
    baixarAnexo: jest.fn(async () => ({ link: 'x' })),
  } as unknown as jest.Mocked<McpUseCases>;
}

async function connect(uc: McpUseCases): Promise<Client> {
  const server = buildMcpServer(uc, { userId: 'u1', baseUrl: 'http://srv' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('ferramentas MCP', () => {
  it('expõe só as ferramentas de leitura ao vivo (nada de sincronizar)', async () => {
    const client = await connect(fakeUseCases());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...FERRAMENTAS].sort());
    for (const t of tools) expect(t.description).not.toContain('sincroniz');
  });

  it('repassa principal (com baseUrl) e argumentos ao caso de uso', async () => {
    const uc = fakeUseCases();
    const client = await connect(uc);
    const res = await client.callTool({ name: 'ver_curso', arguments: { cursoId: '10' } });
    expect(res.isError).toBeFalsy();
    expect(uc.verCurso).toHaveBeenCalledWith({ userId: 'u1', baseUrl: 'http://srv' }, { cursoId: '10' });
  });

  it('ver_curso exige cursoId', async () => {
    const client = await connect(fakeUseCases());
    const res = await client.callTool({ name: 'ver_curso', arguments: {} });
    expect(res.isError).toBe(true);
  });

  it('erro de caso de uso vira resultado isError', async () => {
    const uc = fakeUseCases();
    uc.prazos.mockRejectedValue(new Error('Moodle não conectado'));
    const client = await connect(uc);
    const res = await client.callTool({ name: 'prazos', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain('Moodle não conectado');
  });
});

describe('POST /mcp (Streamable HTTP)', () => {
  let app: INestApplication;
  let url: URL;

  beforeAll(async () => {
    app = await NestFactory.create(McpTestingModule, { logger: false });
    await app.listen(0);
    url = new URL(`${await app.getUrl()}/mcp`.replace('[::1]', 'localhost'));
  });

  afterAll(() => app.close());

  it('rejeita sem Bearer', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('GET não é suportado (sem sessão)', async () => {
    const res = await fetch(url, { headers: { authorization: 'Bearer nao-e-valido' } });
    expect(res.status).toBe(405);
  });

  it('cliente MCP lista ferramentas e chama uma leitura via HTTP', async () => {
    const client = new Client({ name: 'teste', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(FERRAMENTAS.length);
    const res = await client.callTool({ name: 'prazos', arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
  });
});
