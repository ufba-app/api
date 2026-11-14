/**
 * O que as ferramentas MCP precisam dos casos de uso. Tudo é leitura AO VIVO na fonte, com o token guardado da
 * pessoa, na hora da pergunta; nada é gravado (ver docs/MCP.md). Cada consulta lê UMA conta de UMA fonte.
 */

export const MCP_USE_CASES = Symbol('MCP_USE_CASES');
export const MCP_AUTH = Symbol('MCP_AUTH');
export const MCP_MEMORY = Symbol('MCP_MEMORY');

/** Ferramentas `memory_*` (proxy do ai-memory + `memory_status`). Opcional: sem ele o /mcp só tem as ferramentas da casa. */
export interface McpMemory {
  enabled(): boolean;
  listTools(userId: string): Promise<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[]>;
  /** `null` quando o nome não é de memória. */
  call(userId: string, name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean } | null>;
}

export type Fonte = 'moodle' | 'classroom' | 'sigaa';

/** Quem está chamando; resolvido a partir do Bearer. */
export interface McpPrincipal {
  userId: string;
  /** URL pública do serviço (para montar links de download). */
  baseUrl?: string;
  /** Cliente OAuth do token e a chave K (só em tokens OAuth emitidos com credencial do SIGAA). */
  cliente?: { clientId: string; chave?: Buffer };
}

/** Autenticação do /mcp: os mesmos autenticadores do REST (chave de API `plt_` e token OAuth do serviço). */
export interface McpAuth {
  /** Recebe o valor do header Authorization; devolve o principal ou null se ausente/inválido (-> 401). */
  authenticate(authorizationHeader: string | undefined): Promise<McpPrincipal | null>;
}

/** Fonte + conta. Sem `conta`, vale a única conta conectada naquela fonte. */
export interface Alvo {
  fonte?: Fonte;
  conta?: string;
}

export interface ListarCursosInput extends Alvo {
  todas?: boolean;
}

export type PrazosInput = Alvo;

export interface VerCursoInput extends Alvo {
  cursoId: string;
}

export interface VerForumInput extends Alvo {
  forumId: string;
}

export interface VerAvisoInput extends Alvo {
  avisoId: string;
}

export interface BaixarAnexoInput extends Alvo {
  /** Um anexo... */
  ref?: string;
  nome?: string;
  /** ...ou vários da mesma conta (no Classroom, liberados de uma vez no seletor do Google). */
  anexos?: { ref: string; nome?: string }[];
}

export interface McpUseCases {
  /** Contas conectadas por fonte. Não chama fonte nenhuma. */
  listarContas(p: McpPrincipal): Promise<unknown>;
  listarCursos(p: McpPrincipal, input: ListarCursosInput): Promise<unknown>;
  prazos(p: McpPrincipal, input: PrazosInput): Promise<unknown>;
  verCurso(p: McpPrincipal, input: VerCursoInput): Promise<unknown>;
  verForum(p: McpPrincipal, input: VerForumInput): Promise<unknown>;
  /** Texto completo de um aviso (hoje só SIGAA). */
  verAviso(p: McpPrincipal, input: VerAvisoInput): Promise<unknown>;
  /** Devolve um link temporário (uso único) para baixar o anexo na máquina de quem chama. */
  baixarAnexo(p: McpPrincipal, input: BaixarAnexoInput): Promise<unknown>;
}
