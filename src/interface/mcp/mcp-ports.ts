/**
 * O que as ferramentas MCP precisam dos casos de uso. A implementação (`McpUseCasesImpl`) chama os MESMOS serviços
 * de `application/` que o REST usa; aqui só se fala o idioma das ferramentas (português, ids em texto).
 */

export const MCP_USE_CASES = Symbol('MCP_USE_CASES');
export const MCP_AUTH = Symbol('MCP_AUTH');

export type Fonte = 'sigaa' | 'moodle' | 'classroom' | 'calendar';
export type Alcance = 'tudo' | 'curso' | 'item';
export type TipoItem = 'aviso' | 'tarefa' | 'prova' | 'material' | 'forum' | 'outro';
export type InsightTipo = 'cr' | 'trajetoria' | 'pendentes';

/** Quem está chamando; resolvido a partir do Bearer. */
export interface McpPrincipal {
  userId: string;
}

/** Autenticação do /mcp: os mesmos autenticadores do REST (chave de API `plt_` e token OAuth do serviço). */
export interface McpAuth {
  /** Recebe o valor do header Authorization; devolve o principal ou null se ausente/inválido (-> 401). */
  authenticate(authorizationHeader: string | undefined): Promise<McpPrincipal | null>;
}

/** Toda leitura devolve `atualizadoEm` (null se nunca sincronizado). */
export interface Leitura<T = unknown> {
  atualizadoEm: Date | string | null;
  dados: T;
}

export interface SincronizarInput {
  fonte: Fonte;
  alcance: Alcance;
  /** `externalId` do curso (alcance=curso ou item). */
  cursoId?: string;
  /** `externalId` do item (alcance=item). */
  itemId?: string;
  /** Segredo por requisição (senha do SIGAA). Usado em memória, nunca guardado nem logado. */
  credencial?: { usuario?: string; senha?: string };
}

export interface ListarItensInput {
  fonte?: Fonte;
  cursoId?: string;
  tipo?: TipoItem;
  limite?: number;
}

export interface AgendaInput {
  de?: string;
  ate?: string;
}

export interface MudancasInput {
  desde?: string;
}

export interface ImportarHistoricoInput {
  usuario: string;
  senha: string;
}

export interface LerAnexoInput {
  itemId: string;
  anexoId: string;
}

export interface McpUseCases {
  /** Único comando que vai às fontes. */
  sincronizar(p: McpPrincipal, input: SincronizarInput): Promise<unknown>;
  listarItens(p: McpPrincipal, input: ListarItensInput): Promise<Leitura>;
  agenda(p: McpPrincipal, input: AgendaInput): Promise<Leitura>;
  mudancas(p: McpPrincipal, input: MudancasInput): Promise<Leitura>;
  perfil(p: McpPrincipal): Promise<Leitura>;
  historico(p: McpPrincipal): Promise<Leitura>;
  insights(p: McpPrincipal, tipo: InsightTipo): Promise<Leitura>;
  /** Vai ao SIGAA (senha por requisição) e à IA: importa o histórico acadêmico. */
  importarHistorico(p: McpPrincipal, input: ImportarHistoricoInput): Promise<Leitura>;
  /** Busca o conteúdo na fonte sob demanda (cache curto); não é leitura do banco. */
  lerAnexo(p: McpPrincipal, input: LerAnexoInput): Promise<unknown>;
}
