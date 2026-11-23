import { McpUseCasesImpl } from './mcp-use-cases';
import type { McpPrincipal } from './mcp-ports';
import { FERRAMENTAS } from './mcp-tools';

const P: McpPrincipal = { userId: 'u1' };

describe('listar_alunos', () => {
  it('devolve só os alunos, em ordem alfabética, com o total; professor fica de fora', async () => {
    const consulta = {
      listarParticipantes: jest.fn(async () => [
        { nome: 'Vinícius Lima', papeis: ['student'] },
        { nome: 'Prof. X', papeis: ['editingteacher'] },
        { nome: 'Ana Souza', papeis: ['student'] },
        { nome: 'Bruno Alves', papeis: ['student', 'teacherassistant'] },
      ]),
    };
    const impl = new McpUseCasesImpl(consulta as never, {} as never, {} as never);
    const r = (await impl.listarAlunos(P, { cursoId: '359934' })) as { total: number; alunos: string[]; cursoId: string };
    expect(consulta.listarParticipantes).toHaveBeenCalledWith({ userId: 'u1' }, 'MOODLE', undefined, '359934');
    expect(r).toEqual({ cursoId: '359934', total: 3, alunos: ['Ana Souza', 'Bruno Alves', 'Vinícius Lima'] });
  });

  it('está na lista de ferramentas de leitura', () => {
    expect(FERRAMENTAS).toContain('listar_alunos');
  });
});
