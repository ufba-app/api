import type { McpPrincipal, McpUseCases } from '../mcp-ports';

/** Casos de uso vazios, só para testar o transporte e as rotas sem banco (nunca entram no AppModule). */
export class StubMcpUseCases implements McpUseCases {
  async sincronizar() {
    return { counts: { created: 0, updated: 0, removed: 0, unchanged: 0 } };
  }
  async listarItens() {
    return { atualizadoEm: null, dados: [] };
  }
  async agenda() {
    return { atualizadoEm: null, dados: [] };
  }
  async mudancas() {
    return { atualizadoEm: null, dados: [] };
  }
  async perfil() {
    return { atualizadoEm: null, dados: null };
  }
  async historico() {
    return { atualizadoEm: null, dados: null };
  }
  async insights() {
    return { atualizadoEm: null, dados: null };
  }
  async importarHistorico(_p: McpPrincipal) {
    return { atualizadoEm: null, dados: null };
  }
  async lerAnexo() {
    throw new Error('lerAnexo não disponível no stub de teste');
  }
}
