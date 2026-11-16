import { McpUseCasesImpl, normalizarNome } from './mcp-use-cases';

describe('normalizarNome', () => {
  it('põe cada palavra em maiúscula e mantém as partículas minúsculas no meio do nome', () => {
    expect(normalizarNome('ADALBERTO MANOEL DO BOMFIM NETO')).toBe('Adalberto Manoel do Bomfim Neto');
    expect(normalizarNome('MARIA CLARA ANDRADE MAGALHAES PATERNOSTRO D OLIVEIRA')).toBe('Maria Clara Andrade Magalhaes Paternostro D Oliveira');
  });

  it('não mexe em nome que já está certo e não tira acento', () => {
    expect(normalizarNome('Vinícius Silva de Jesus')).toBe('Vinícius Silva de Jesus');
    expect(normalizarNome('JULIA TEIXEIRA GONÇALVES')).toBe('Julia Teixeira Gonçalves');
  });

  it('limpa espaços sobrando', () => {
    expect(normalizarNome('  ANA    SOUZA ')).toBe('Ana Souza');
  });

  it('a primeira palavra fica maiúscula mesmo se for partícula', () => {
    expect(normalizarNome('DE SOUZA LIMA')).toBe('De Souza Lima');
  });
});

describe('listar_alunos devolve os nomes normalizados', () => {
  it('SIGAA (maiúsculas) e Moodle saem no mesmo padrão, em ordem alfabética', async () => {
    const consulta = {
      listarParticipantes: jest.fn(async () => [
        { nome: 'ZELIA DA SILVA', papeis: ['student'] },
        { nome: 'Ana Souza', papeis: ['student'] },
        { nome: 'PROF. X', papeis: ['editingteacher'] },
      ]),
    };
    const impl = new McpUseCasesImpl(consulta as never, {} as never);
    const r = (await impl.listarAlunos({ userId: 'u1' }, { cursoId: '1' })) as { alunos: string[] };
    expect(r.alunos).toEqual(['Ana Souza', 'Zelia da Silva']);
  });
});
