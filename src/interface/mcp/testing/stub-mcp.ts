import type { McpUseCases } from '../mcp-ports';

/** Casos de uso vazios, só para testar o transporte e as rotas sem banco (nunca entram no AppModule). */
export class StubMcpUseCases implements McpUseCases {
  async listarContas() {
    return { contas: [] };
  }
  async listarCursos() {
    return { cursos: [] };
  }
  async prazos() {
    return { prazos: [] };
  }
  async verCurso() {
    return { atividades: [] };
  }
  async verForum() {
    return { discussoes: [] };
  }
  async baixarAnexo() {
    return { link: 'http://localhost/download/x' };
  }
}
