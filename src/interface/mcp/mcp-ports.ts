/**
 * O que as ferramentas MCP precisam dos casos de uso. Tudo é leitura AO VIVO na fonte, com o token guardado da
 * pessoa, na hora da pergunta; nada é gravado (ver docs/MCP.md), salvo as `McpClinicaWrite` do SIASB (só com `confirmado` e a permissão do app). Cada consulta lê UMA conta de UMA fonte. Exceção:
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
import type { SiasbWriter } from '../../application/siasb/siasb-writer';
import type { ClinicalSession } from '../../domain/siasb/types';

export const MCP_USE_CASES = Symbol('MCP_USE_CASES');
export const MCP_AUTH = Symbol('MCP_AUTH');
export const MCP_MEMORY = Symbol('MCP_MEMORY');
export const MCP_CLINICA = Symbol('MCP_CLINICA');

/**
 * Clínicas do SIASB (`clinica_*`). Opcional: sem ele o /mcp não oferece essas ferramentas. A leitura é AO VIVO com a
 * conexão da pessoa, exceto `copySessions` (cópia da última sincronização); a leitura não grava nada no SIASB (a escrita é a `McpClinicaWrite`, opt-in por permissão).
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
  /** Escrita no SIASB (agenda e procedimentos previstos); `undefined` quando o serviço não tem o escritor. */
  writes?(): McpClinicaWrite | undefined;
}

/**
 * Escrita no SIASB em nome da pessoa, em duas etapas (resumo e depois `confirmed: true`). As mesmas assinaturas do
 * `SiasbWriter`; as ferramentas só aparecem com a permissão de agenda ou de procedimentos do app.
 */
export interface McpClinicaWrite {
  scheduleSession: SiasbWriter['scheduleSession'];
  unscheduleSession: SiasbWriter['unscheduleSession'];
  addProcedure: SiasbWriter['addProcedure'];
  removeProcedure: SiasbWriter['removeProcedure'];
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

/** Um tópico de fórum: todas as mensagens, com as respostas. */
export interface VerTopicoInput extends Alvo {
  discussaoId: string;
}

/** Os alunos de uma matéria (o `id` de `listar_cursos`). */
export interface ListarAlunosInput extends Alvo {
  cursoId: string;
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

/** Uma tarefa do Moodle: o `cursoId` de `listar_cursos` e, como `tarefaId`, o `id` da atividade em `ver_curso` (o cmid do Moodle). */
export interface PrepararEnvioInput {
  conta?: string;
  cursoId: string;
  tarefaId: string;
}

/** Uma tarefa do Moodle, só para ler (entrega, nota, feedback): mesmos ids de `PrepararEnvioInput`. */
export type VerTarefaInput = PrepararEnvioInput;

/**
 * Entrega de tarefa em duas chamadas: sem `confirmacaoId` só devolve o resumo (não grava); com ele, grava.
 * Arquivos pelo link de upload (`uploadId`) ou pequenos em base64 (`arquivos`).
 */
export interface EnvioTarefaInput extends PrepararEnvioInput {
  texto?: string;
  uploadId?: string;
  arquivos?: { nome: string; conteudoBase64: string }[];
  confirmacaoId?: string;
}

export interface McpUseCases {
  /** Contas conectadas por fonte. Não chama fonte nenhuma. */
  listarContas(p: McpPrincipal): Promise<unknown>;
  listarCursos(p: McpPrincipal, input: ListarCursosInput): Promise<unknown>;
  prazos(p: McpPrincipal, input: PrazosInput): Promise<unknown>;
  verCurso(p: McpPrincipal, input: VerCursoInput): Promise<unknown>;
  verForum(p: McpPrincipal, input: VerForumInput): Promise<unknown>;
  /** Todas as mensagens de um tópico, com as respostas (`respostaA` liga cada uma à sua origem). */
  verTopico(p: McpPrincipal, input: VerTopicoInput): Promise<unknown>;
  /** Nomes dos alunos de uma matéria (só o nome; sem contato). */
  listarAlunos(p: McpPrincipal, input: ListarAlunosInput): Promise<unknown>;
  /** Estado da entrega, nota e feedback do professor de UMA tarefa do Moodle. Só lê (sem permissão de escrita). */
  verTarefa(p: McpPrincipal, input: VerTarefaInput): Promise<unknown>;
  /** Texto completo de um aviso (hoje só SIGAA). */
  verAviso(p: McpPrincipal, input: VerAvisoInput): Promise<unknown>;
  /** Devolve um link temporário (uso único) para baixar o anexo na máquina de quem chama. */
  baixarAnexo(p: McpPrincipal, input: BaixarAnexoInput): Promise<unknown>;
  /** Publica no fórum do Moodle (escrita; só existe no MCP com a permissão `moodle.forum_write`). */
  postarForum(p: McpPrincipal, input: PostarForumInput): Promise<unknown>;
  /** O que a tarefa pede e, se aceita arquivo, o link de upload de uso único. Não grava (permissão `moodle.assignment_write`). */
  prepararEnvioTarefa(p: McpPrincipal, input: PrepararEnvioInput): Promise<unknown>;
  /** Salva como rascunho (só em tarefa com o botão de enviar), em duas chamadas (`confirmacaoId`). */
  salvarRascunhoTarefa(p: McpPrincipal, input: EnvioTarefaInput): Promise<unknown>;
  /** Entrega ao professor, em duas chamadas (`confirmacaoId`). */
  enviarTarefa(p: McpPrincipal, input: EnvioTarefaInput): Promise<unknown>;
}
