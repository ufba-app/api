/**
 * Contrato que a interface MCP espera dos casos de uso. Os mesmos casos de uso servem o REST.
 * Enquanto o Núcleo (Forja) não publica `src/application`, a composição liga o stub
 * (`StubMcpUseCases`); quando publicar, basta um adaptador que implemente `McpUseCases`.
 */

export const MCP_USE_CASES = Symbol('MCP_USE_CASES');
export const MCP_AUTH = Symbol('MCP_AUTH');

export type Fonte = 'sigaa' | 'moodle' | 'classroom' | 'calendar';
export type Alcance = 'tudo' | 'curso' | 'item';

/** Quem está chamando; resolvido a partir do Bearer. */
export interface McpPrincipal {
  userId: string;
}

/** Autenticação do /mcp: chave de API (Bearer) hoje, access token OAuth depois. */
export interface McpAuth {
  /** Recebe o valor do header Authorization; devolve o principal ou null se inválido. */
  authenticate(authorizationHeader: string | undefined): Promise<McpPrincipal | null>;
}

/** Toda leitura devolve `atualizadoEm` (ISO 8601 ou null se nunca sincronizado). */
export interface Leitura<T> {
  atualizadoEm: string | null;
  dados: T;
}

export interface SincronizarInput {
  fonte: Fonte;
  alcance: Alcance;
  /** Id do curso (alcance=curso) ou do item (alcance=item). */
  alvoId?: string;
  /** Segredo por requisição (ex.: senha do SIGAA). Usado em memória, nunca guardado. */
  credencial?: { usuario?: string; senha?: string };
}

export interface SincronizarResultado {
  fonte: Fonte;
  alcance: Alcance;
  novos: number;
  alterados: number;
  removidos: number;
  atualizadoEm: string;
}

export interface ListarItensInput {
  fonte?: Fonte;
  cursoId?: string;
  tipo?: 'aviso' | 'tarefa' | 'prova' | 'material' | 'forum';
  limite?: number;
}

export interface AgendaInput {
  de?: string;
  ate?: string;
}

export interface MudancasInput {
  desde?: string;
  fonte?: Fonte;
}

export interface HistoricoInput {
  incluirPendentes?: boolean;
}

export type InsightTipo = 'cr' | 'trajetoria' | 'pendentes';

export interface LerAnexoInput {
  itemId: string;
  anexoId: string;
}

export interface Anexo {
  nome: string;
  mimeType: string;
  /** Texto extraído, ou base64 quando binário pequeno. */
  conteudo: string;
  codificacao: 'texto' | 'base64';
}

export interface McpUseCases {
  /** Único que vai às fontes. */
  sincronizar(p: McpPrincipal, input: SincronizarInput): Promise<SincronizarResultado>;
  listarItens(p: McpPrincipal, input: ListarItensInput): Promise<Leitura<unknown[]>>;
  agenda(p: McpPrincipal, input: AgendaInput): Promise<Leitura<unknown[]>>;
  mudancas(p: McpPrincipal, input: MudancasInput): Promise<Leitura<unknown[]>>;
  perfil(p: McpPrincipal): Promise<Leitura<unknown>>;
  historico(p: McpPrincipal, input: HistoricoInput): Promise<Leitura<unknown>>;
  insights(p: McpPrincipal, tipo: InsightTipo): Promise<Leitura<unknown>>;
  /** Busca o conteúdo na fonte sob demanda (cache curto), não é leitura do banco. */
  lerAnexo(p: McpPrincipal, input: LerAnexoInput): Promise<Anexo>;
}
