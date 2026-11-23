import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpTestingModule, TEST_API_KEY } from './testing/mcp-testing.module';
import { buildMcpServer, FERRAMENTAS } from './mcp-tools';
import { McpPrincipal, McpUseCases } from './mcp-ports';
import { McpUseCasesImpl } from './mcp-use-cases';
import { ConsultaService } from '../../application/live/consulta.service';
import { DownloadLinks } from '../../application/live/download-links';
import { LiveSources, type LiveSource } from '../../application/ports/live-source';
import { Secret } from '../../application/shared/secret';
import { InMemoryCredentials, InMemoryVaults, cifraDeTeste as cifra } from '../../../test/support/sigaa-store-fake';
import { CofreSigaa } from '../../application/sigaa/cofre-sigaa';

function fakeUseCases(): jest.Mocked<McpUseCases> {
  return {
    listarCursos: jest.fn(async () => ({ cursos: [{ id: '10', nome: 'Tópicos' }] })),
    prazos: jest.fn(async () => ({ prazos: [] })),
    verCurso: jest.fn(async () => ({ atividades: [] })),
    verForum: jest.fn(async () => ({ discussoes: [] })),
    verAviso: jest.fn(async () => ({ aviso: {} })),
    baixarAnexo: jest.fn(async () => ({ link: 'x' })),
  } as unknown as jest.Mocked<McpUseCases>;
}

async function connect(uc: McpUseCases, p: McpPrincipal = { userId: 'u1', baseUrl: 'http://srv' }): Promise<Client> {
  const server = buildMcpServer(uc, p);
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

describe('ferramentas MCP com o SIGAA (casos de uso reais, fonte e cofre falsos)', () => {
  const K = Buffer.alloc(32, 3);
  async function montar() {
    const chamadas: string[] = [];
    const sigaa = {
      provider: 'SIGAA',
      listarCursos: async () => (chamadas.push('listarCursos'), []),
      prazos: async () => (chamadas.push('prazos'), []),
      verCurso: async () => (chamadas.push('verCurso'), []),
      verForum: async () => (chamadas.push('verForum'), []),
      baixar: async () => (chamadas.push('baixar'), {}) as never,
      verAviso: async (_c: unknown, id: string) => (chamadas.push('verAviso'), { id, titulo: 'Aviso', anexos: [] }),
    } as unknown as LiveSource;
    const live = new LiveSources();
    live.register(sigaa);
    const cofre = new CofreSigaa(new InMemoryCredentials(), new InMemoryVaults(), cifra);
    await cofre.gravar({ userId: 'u1', clientId: 'c1' }, { login: 'aluno', senha: Secret.of('senha-falsa') }, K);
    const accounts = { findByUserAndProvider: async () => [], listByUser: async () => [], setStatus: jest.fn() } as never;
    const consulta = new ConsultaService(live, accounts, { decrypt: () => 'x' } as never, cofre);
    return { uc: new McpUseCasesImpl(consulta, new DownloadLinks(), {} as never), chamadas };
  }

  const texto = (res: unknown) => ((res as { content: { text: string }[] }).content)[0].text;

  it('token sem K ou chave plt_ pedindo SIGAA: erro claro, zero chamadas à fonte', async () => {
    const { uc, chamadas } = await montar();
    for (const p of [{ userId: 'u1' }, { userId: 'u1', cliente: { clientId: 'c1' } }] as McpPrincipal[]) {
      const client = await connect(uc, p);
      for (const [name, args] of [
        ['listar_cursos', { fonte: 'sigaa' }],
        ['prazos', { fonte: 'sigaa' }],
        ['ver_curso', { fonte: 'sigaa', cursoId: 't1' }],
        ['ver_aviso', { fonte: 'sigaa', avisoId: 'av1' }],
      ] as const) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect(texto(res)).toContain('SIGAA não conectado neste aplicativo');
      }
      const contas = await client.callTool({ name: 'listar_contas', arguments: {} });
      expect(JSON.parse(texto(contas))).toEqual({ contas: [] });
    }
    expect(chamadas).toEqual([]);
  });

  it('com K no token: listar_contas mostra o SIGAA e ver_aviso lê da fonte', async () => {
    const { uc, chamadas } = await montar();
    const client = await connect(uc, { userId: 'u1', cliente: { clientId: 'c1', chave: K } });
    const contas = await client.callTool({ name: 'listar_contas', arguments: {} });
    expect(JSON.parse(texto(contas))).toEqual({ contas: [{ fonte: 'sigaa', conta: 'aluno' }] });
    const aviso = await client.callTool({ name: 'ver_aviso', arguments: { fonte: 'sigaa', avisoId: 'av1' } });
    expect(aviso.isError).toBeFalsy();
    expect(JSON.parse(texto(aviso))).toMatchObject({ aviso: { id: 'av1', titulo: 'Aviso' } });
    expect(chamadas).toEqual(['verAviso']);
  });

  it('baixar_anexo no SIGAA: erro claro, sem link', async () => {
    const { uc, chamadas } = await montar();
    const client = await connect(uc, { userId: 'u1', cliente: { clientId: 'c1', chave: K } });
    const res = await client.callTool({ name: 'baixar_anexo', arguments: { fonte: 'sigaa', ref: 'x' } });
    expect(res.isError).toBe(true);
    expect(texto(res)).not.toContain('/download/');
    expect(chamadas).toEqual([]);
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
