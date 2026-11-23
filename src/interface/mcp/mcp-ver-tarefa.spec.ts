import { McpUseCasesImpl } from './mcp-use-cases';
import type { McpPrincipal } from './mcp-ports';

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
});
