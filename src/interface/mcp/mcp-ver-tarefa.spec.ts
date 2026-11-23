import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpUseCasesImpl } from './mcp-use-cases';
import type { McpPrincipal, McpUseCases } from './mcp-ports';
import { buildMcpServer, FERRAMENTAS } from './mcp-tools';

async function connect(uc: Partial<McpUseCases>, p: McpPrincipal): Promise<Client> {
  const server = buildMcpServer(uc as McpUseCases, p);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const P: McpPrincipal = { userId: 'u1' };

describe('ver_tarefa (caso de uso)', () => {
  it('repassa conta, curso e cmid ao serviço e devolve a tarefa como veio', async () => {
    const tarefa = { tarefaId: '4286503', avaliacao: { avaliada: true, nota: '100,00 / 100,00', comentarios: ['Excelente trabalho.'] } };
    const consulta = { verTarefa: jest.fn(async () => tarefa) };
    const impl = new McpUseCasesImpl(consulta as never, {} as never, {} as never);
    const r = await impl.verTarefa(P, { conta: 'ava', cursoId: '359937', tarefaId: '4286503' });
    expect(consulta.verTarefa).toHaveBeenCalledWith({ userId: 'u1' }, 'ava', '359937', '4286503');
    expect(r).toBe(tarefa);
  });

  it('a ferramenta existe sem nenhuma permissão de escrita, é só leitura e repassa os ids', async () => {
    expect(FERRAMENTAS).toContain('ver_tarefa');
    const verTarefa = jest.fn(async () => ({ tarefaId: '4286503' }));
    const client = await connect({ verTarefa }, P);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'ver_tarefa');
    expect(t?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.map((x) => x.name)).not.toContain('preparar_envio_tarefa');
    const r = await client.callTool({ name: 'ver_tarefa', arguments: { cursoId: '359937', tarefaId: '4286503' } });
    expect(verTarefa).toHaveBeenCalledWith(P, { cursoId: '359937', tarefaId: '4286503' });
    expect(JSON.stringify(r.content)).toContain('4286503');
  });
});
