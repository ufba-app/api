import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpModule } from './mcp.module';
import { buildMcpServer, FERRAMENTAS_LEITURA } from './mcp-tools';
import { McpUseCases } from './mcp-ports';

/** Gateway de fonte falso: qualquer chamada nele é uma ida à fonte externa. */
const gateway = { fetch: jest.fn() };

/**
 * Casos de uso falsos no formato do contrato: só `sincronizar` e `lerAnexo` tocam o gateway,
 * como no desenho (ARQUITETURA §2.2). Leituras só devolvem dados do "banco".
 */
function fakeUseCases(): jest.Mocked<McpUseCases> {
  const leitura = async (..._args: unknown[]) => ({ atualizadoEm: '2026-10-31T10:00:00.000Z', dados: [] });
  return {
    sincronizar: jest.fn(async (_p, i) => {
      await gateway.fetch(i);
      return { fonte: i.fonte, alcance: i.alcance, novos: 1, alterados: 0, removidos: 0, atualizadoEm: 'x' };
    }),
    listarItens: jest.fn(leitura),
    agenda: jest.fn(leitura),
    mudancas: jest.fn(leitura),
    perfil: jest.fn(leitura),
    historico: jest.fn(leitura),
    insights: jest.fn(leitura),
    lerAnexo: jest.fn(async (_p, _i) => {
      await gateway.fetch('anexo');
      return { nome: 'a.txt', mimeType: 'text/plain', conteudo: 'oi', codificacao: 'texto' as const };
    }),
  } as unknown as jest.Mocked<McpUseCases>;
}

const ARGS: Record<(typeof FERRAMENTAS_LEITURA)[number], Record<string, unknown>> = {
  listar_itens: {},
  agenda: {},
  mudancas: {},
  perfil: {},
  historico: {},
  insights: { tipo: 'cr' },
};

async function connect(uc: McpUseCases): Promise<Client> {
  const server = buildMcpServer(uc, { userId: 'u1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('ferramentas MCP', () => {
  beforeEach(() => gateway.fetch.mockClear());

  it('expõe as ferramentas em português', async () => {
    const client = await connect(fakeUseCases());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['agenda', 'historico', 'insights', 'ler_anexo', 'listar_itens', 'mudancas', 'perfil', 'sincronizar'],
    );
  });

  it.each(FERRAMENTAS_LEITURA)('%s não chama gateway de fonte nem sincronizar', async (nome) => {
    const uc = fakeUseCases();
    const client = await connect(uc);

    const res = await client.callTool({ name: nome, arguments: ARGS[nome] });

    expect(res.isError).toBeFalsy();
    expect(gateway.fetch).not.toHaveBeenCalled();
    expect(uc.sincronizar).not.toHaveBeenCalled();
    expect(uc.lerAnexo).not.toHaveBeenCalled();
    const text = (res.content as { text: string }[])[0].text;
    expect(JSON.parse(text).atualizadoEm).toBe('2026-10-31T10:00:00.000Z');
  });

  it('descrições de leitura orientam a sincronizar quando velho', async () => {
    const client = await connect(fakeUseCases());
    const { tools } = await client.listTools();
    for (const t of tools.filter((x) => (FERRAMENTAS_LEITURA as readonly string[]).includes(x.name))) {
      expect(t.description).toContain('atualizadoEm');
      expect(t.description).toContain('sincronizar');
    }
  });

  it('sincronizar é o que vai à fonte, repassando a credencial só ao caso de uso', async () => {
    const uc = fakeUseCases();
    const client = await connect(uc);

    await client.callTool({
      name: 'sincronizar',
      arguments: { fonte: 'sigaa', alcance: 'tudo', credencial: { usuario: 'u', senha: 's' } },
    });

    expect(gateway.fetch).toHaveBeenCalledTimes(1);
    expect(uc.sincronizar).toHaveBeenCalledWith(
      { userId: 'u1' },
      expect.objectContaining({ fonte: 'sigaa', alcance: 'tudo' }),
    );
  });

  it('erro de caso de uso vira resultado isError', async () => {
    const uc = fakeUseCases();
    uc.perfil.mockRejectedValue(new Error('falhou'));
    const client = await connect(uc);
    const res = await client.callTool({ name: 'perfil', arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe('POST /mcp (Streamable HTTP)', () => {
  let app: INestApplication;
  let url: URL;

  beforeAll(async () => {
    app = await NestFactory.create(McpModule, { logger: false });
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
    const res = await fetch(url, { headers: { authorization: 'Bearer x' } });
    expect(res.status).toBe(405);
  });

  it('cliente MCP lista ferramentas e chama uma leitura via HTTP', async () => {
    const client = new Client({ name: 'teste', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer chave-qualquer' } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    const res = await client.callTool({ name: 'agenda', arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
  });
});
