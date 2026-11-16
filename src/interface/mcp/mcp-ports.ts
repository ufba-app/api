/**
 * O que as ferramentas MCP precisam dos casos de uso. Tudo é leitura AO VIVO na fonte, com o token guardado da
 * pessoa, na hora da pergunta; nada é gravado (ver docs/MCP.md). Cada consulta lê UMA conta de UMA fonte. Exceção:
 * `clinica_sessoes` lê por padrão a cópia da última sincronização do SIASB.
 */

import type {
  BookingDeadline,
  DisciplineSituation,
  PatientsByDiscipline,
  SchedulingContext,
} from '../../application/siasb/siasb-reader';
import type { CalendarItem } from '../../application/siasb/siasb-copy-reader';
import type { Progress } from '../../application/siasb/progress';
import type { ClinicalSession } from '../../domain/siasb/types';

export const MCP_USE_CASES = Symbol('MCP_USE_CASES');
export const MCP_AUTH = Symbol('MCP_AUTH');
export const MCP_MEMORY = Symbol('MCP_MEMORY');
export const MCP_CLINICA = Symbol('MCP_CLINICA');

/**
 * Clínicas do SIASB (`clinica_*`). Opcional: sem ele o /mcp não oferece essas ferramentas. A leitura é AO VIVO com a
 * conexão da pessoa, exceto `copySessions` (cópia da última sincronização); nada é gravado no SIASB.
 */
export interface McpClinica {
  /** A pessoa tem conexão SIASB em qualquer estado (conectada ou a reconectar). */
  hasConnection(userId: string): Promise<boolean>;
  situation(userId: string): Promise<DisciplineSituation[]>;
  sessions(userId: string, range?: { from: Date; to: Date }): Promise<ClinicalSession[]>;
  /**
   * Sessões lidas da cópia da última sincronização (não consulta o SIASB). Mesmas regras de período de `sessions`
   * (`resolveSessionPeriod`; `de` depois de `ate` lança `InvalidPeriodError`). `syncedAt` nulo e sem itens = nunca
   * sincronizou. `null` = a cópia não cobre o período (começa antes da janela sincronizada ou está além do alcance):
   * quem chama lê ao vivo.
   */
  copySessions(
    userId: string,
    range?: { from: Date; to: Date },
  ): Promise<{ syncedAt: Date | null; stale: boolean; items: CalendarItem[] } | null>;
  bookingDeadline(userId: string, input: { disciplineId: string } | { sessionStart: Date }): Promise<BookingDeadline>;
  patients(userId: string): Promise<PatientsByDiscipline[]>;
  vacancies(userId: string): Promise<{ disciplineId: string; disciplineName: string; count: number }[]>;
  schedulingContext(userId: string, attendanceId: string, term?: string): Promise<SchedulingContext>;
  progress(userId: string, range?: { from: Date; to: Date }): Promise<Progress>;
}

/** Ferramentas `memory_*` (proxy do ai-memory + `memory_status`). Opcional: sem ele o /mcp só tem as ferramentas da casa. */
export interface McpMemory {
  enabled(): boolean;
  listTools(userId: string, client?: { name?: string | null }): Promise<{ name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[]>;
  /** `null` quando o nome não é de memória. */
  call(userId: string, name: string, args: Record<string, unknown>, client?: { name?: string | null }): Promise<{ content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean } | null>;
}

export type Fonte = 'moodle' | 'classroom' | 'sigaa';

/** Quem está chamando; resolvido a partir do Bearer. */
export interface McpPrincipal {
  userId: string;
  /** URL pública do serviço (para montar links de download). */
  baseUrl?: string;
  /** Cliente OAuth do token e a chave K (só em tokens OAuth emitidos com credencial do SIGAA). */
  cliente?: { clientId: string; chave?: Buffer };
  /** Chaves de permissão concedidas ao APP que chama (`client_permissions`); sem a chave, a ferramenta de escrita nem é registrada. */
  permissions?: ReadonlySet<string>;
  /** A pessoa tem conexão SIASB (qualquer estado), decidido por requisição. Liga as ferramentas `clinica_*`. */
  siasb?: boolean;
  /** `clientInfo.name` do `initialize` deste token (guardado entre as requisições); ausente = cliente desconhecido. */
  clientName?: string;
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

/** Publicação no fórum do Moodle: `forumId` (nova discussão) ou `postId` (resposta), e sempre `titulo` e `mensagem`. */
export interface PostarForumInput {
  conta?: string;
  forumId?: string;
  postId?: string;
  titulo: string;
  mensagem: string;
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
  /** Publica no fórum do Moodle (escrita; só existe no MCP com a permissão `moodle.forum_write`). */
  postarForum(p: McpPrincipal, input: PostarForumInput): Promise<unknown>;
}
