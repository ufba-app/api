import { McpUseCasesImpl } from './mcp-use-cases';
import type { McpPrincipal } from './mcp-ports';
import { buildMcpServer, FERRAMENTAS } from './mcp-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const P: McpPrincipal = { userId: 'u1' };

function uc() {
  const consulta = {
    verForum: jest.fn(async () => [{ id: '612607', titulo: 'Apresentação dos Projetos', anexos: [] }]),
    verTopico: jest.fn(async () => [{ postId: '7', anexos: [] }]),
  };
  return { impl: new McpUseCasesImpl(consulta as never, {} as never, {} as never), consulta };
}

describe('ver_forum (lista de tópicos) e ver_topico (mensagens de um tópico)', () => {
  it('ver_forum lê só a lista de tópicos', async () => {
    const { impl, consulta } = uc();
    const r = (await impl.verForum(P, { forumId: '587394' })) as { discussoes: unknown[] };
    expect(consulta.verForum).toHaveBeenCalledWith({ userId: 'u1' }, 'MOODLE', undefined, '587394');
    expect(consulta.verTopico).not.toHaveBeenCalled();
    expect(r.discussoes).toHaveLength(1);
  });

  it('ver_topico lê as mensagens do tópico, e não a lista', async () => {
    const { impl, consulta } = uc();
    const r = (await impl.verTopico(P, { discussaoId: '612607' })) as { mensagens: unknown[]; discussaoId: string };
    expect(consulta.verTopico).toHaveBeenCalledWith({ userId: 'u1' }, 'MOODLE', undefined, '612607');
    expect(consulta.verForum).not.toHaveBeenCalled();
    expect(r.discussaoId).toBe('612607');
    expect(r.mensagens).toHaveLength(1);
  });

  it('ver_topico está na lista de ferramentas, de leitura, com discussaoId obrigatório', async () => {
    expect(FERRAMENTAS).toContain('ver_topico');
    const server = buildMcpServer({} as never, P);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const t = (await client.listTools()).tools.find((x) => x.name === 'ver_topico')!;
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(t.inputSchema.required).toContain('discussaoId');
  });
});
