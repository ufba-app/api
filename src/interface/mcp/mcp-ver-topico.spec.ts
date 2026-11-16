import { McpUseCasesImpl } from './mcp-use-cases';
import type { McpPrincipal } from './mcp-ports';

const P: McpPrincipal = { userId: 'u1' };

function uc() {
  const consulta = {
    verForum: jest.fn(async () => [{ id: '612607', titulo: 'Apresentação dos Projetos', anexos: [] }]),
    verTopico: jest.fn(async () => [{ postId: '7', anexos: [] }]),
  };
  return { impl: new McpUseCasesImpl(consulta as never, {} as never), consulta };
}

describe('ver_forum: lista de tópicos ou mensagens de um tópico', () => {
  it('com forumId lê a lista de tópicos e não toca o tópico', async () => {
    const { impl, consulta } = uc();
    const r = (await impl.verForum(P, { forumId: '587394' })) as { discussoes: unknown[] };
    expect(consulta.verForum).toHaveBeenCalledWith({ userId: 'u1' }, 'MOODLE', undefined, '587394');
    expect(consulta.verTopico).not.toHaveBeenCalled();
    expect(r.discussoes).toHaveLength(1);
  });

  it('com discussaoId lê as mensagens do tópico (com respostas), e não a lista', async () => {
    const { impl, consulta } = uc();
    const r = (await impl.verForum(P, { discussaoId: '612607' })) as { mensagens: unknown[]; discussaoId: string };
    expect(consulta.verTopico).toHaveBeenCalledWith({ userId: 'u1' }, 'MOODLE', undefined, '612607');
    expect(consulta.verForum).not.toHaveBeenCalled();
    expect(r.discussaoId).toBe('612607');
    expect(r.mensagens).toHaveLength(1);
  });

  it('exatamente um dos dois: nem nenhum, nem os dois chegam à fonte', async () => {
    const { impl, consulta } = uc();
    await expect(impl.verForum(P, {})).rejects.toThrow('não os dois');
    await expect(impl.verForum(P, { forumId: '1', discussaoId: '2' })).rejects.toThrow('não os dois');
    expect(consulta.verForum).not.toHaveBeenCalled();
    expect(consulta.verTopico).not.toHaveBeenCalled();
  });
});
