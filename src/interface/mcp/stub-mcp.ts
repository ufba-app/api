import {
  Anexo,
  McpAuth,
  McpPrincipal,
  McpUseCases,
  SincronizarInput,
  SincronizarResultado,
} from './mcp-ports';

/** Stub de auth: aceita qualquer Bearer não vazio. Trocar pelo guard do Núcleo (chave de API / OAuth). */
export class StubMcpAuth implements McpAuth {
  async authenticate(header: string | undefined): Promise<McpPrincipal | null> {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    return match ? { userId: 'stub-user' } : null;
  }
}

/** Stub de casos de uso: nada sincronizado ainda. Trocar pelos casos de uso do Núcleo. */
export class StubMcpUseCases implements McpUseCases {
  async sincronizar(_p: McpPrincipal, i: SincronizarInput): Promise<SincronizarResultado> {
    return {
      fonte: i.fonte,
      alcance: i.alcance,
      novos: 0,
      alterados: 0,
      removidos: 0,
      atualizadoEm: new Date().toISOString(),
    };
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
  async lerAnexo(): Promise<Anexo> {
    throw new Error('lerAnexo ainda não implementado pelo Núcleo');
  }
}
