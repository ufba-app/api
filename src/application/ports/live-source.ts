import type { AttachmentContent } from './attachment-reader';
import type { ClassSchedule } from '../../domain/academic/class-schedule';
import type { Provider, SourceContext } from './source-gateway';

/**
 * Leitura AO VIVO de uma fonte: cada método faz só as chamadas necessárias para responder aquela pergunta, na hora,
 * com o token guardado da pessoa. Nada é gravado no banco. Ver docs/MCP.md.
 */

export interface CursoVivo {
  id: string;
  nome: string;
  codigo?: string;
  url?: string;
}

/** Arquivo ou link que a pessoa abre no próprio navegador (ex.: Drive do Classroom), sem passar pelo serviço. */
export interface LinkVivo {
  nome: string;
  url: string;
}

/** `ref` é opaco para quem chama: só serve para pedir o download (`baixar`). */
export interface AnexoVivo {
  nome: string;
  mimeType?: string;
  tamanhoBytes?: number;
  ref: string;
}

export type TipoAtividade = 'tarefa' | 'prova' | 'material' | 'forum' | 'aviso' | 'outro';

export interface AtividadeViva {
  id: string;
  tipo: TipoAtividade;
  titulo: string;
  secao?: string;
  descricao?: string;
  prazo?: Date;
  url?: string;
  anexos: AnexoVivo[];
  /** Links externos citados na atividade. */
  links?: string[];
  /** Arquivos para abrir no navegador da pessoa (não passam por `baixar`). */
  abrirNoNavegador?: LinkVivo[];
  /** Para `tipo: forum`: id para `verForum`. */
  forumId?: string;
}

export interface PrazoVivo {
  id: string;
  titulo: string;
  quando: Date;
  cursoId?: string;
  cursoNome?: string;
  tipo?: string;
  descricao?: string;
  url?: string;
}

export interface DiscussaoViva {
  id: string;
  /** Id da mensagem inicial da discussão: é o que se passa para responder (`postarForum` com `postId`). */
  postId?: string;
  titulo: string;
  mensagem?: string;
  autor?: string;
  publicadaEm?: Date;
  anexos: AnexoVivo[];
}

/** Frequência de UMA turma, em aulas (55 min). A fonte só informa presenças; a falta é `aulasRegistradas − presencas`. */
export interface FrequenciaViva {
  cursoId: string;
  cursoNome: string;
  presencas: number;
  /** Aulas com frequência lançada pelo professor até agora. */
  aulasRegistradas: number;
  /** Aulas definidas pela carga horária do componente. */
  aulasCH: number;
  /** `false` quando a fonte avisa que a frequência ainda não foi lançada por completo. */
  completa: boolean;
}

/** Um participante da matéria: só o nome e os papéis (ex.: `student`, `editingteacher`). Nada de e-mail ou id. */
export interface ParticipanteVivo {
  nome: string;
  papeis: string[];
}

/** Uma mensagem de um tópico (a inicial ou uma resposta), na ordem em que foi postada. */
export interface MensagemViva {
  /** Id da mensagem: passe em `postarForum` (com `postId`) para responder a ela. */
  postId: string;
  /** Id da mensagem a que esta responde; ausente na mensagem inicial. */
  respostaA?: string;
  autor?: string;
  publicadaEm?: Date;
  mensagem?: string;
  anexos: AnexoVivo[];
}

/** Publicação em fórum: nova discussão (`forumId`) ou resposta a uma mensagem (`postId`). Exatamente um dos dois. */
export interface PostagemForum {
  forumId?: string;
  postId?: string;
  titulo: string;
  mensagem: string;
}

/** Situação de uma tarefa para o aluno: entrega, nota e feedback do professor. `tarefaId` é o cmid público de `ver_curso`. */
export interface TarefaVista {
  tarefaId: string;
  titulo: string;
  prazo?: Date;
  estado: 'nova' | 'rascunho' | 'entregue';
  enviadoEm?: Date;
  /** Envio depois do prazo (considera a prorrogação). Sem prazo ou sem entrega: `false`. */
  atrasada: boolean;
  arquivosAtuais: { nome: string; tamanhoBytes: number }[];
  /** Se a entrega atual tem texto online (não o texto: só se existe). */
  temTextoAtual: boolean;
  /** Sem nota ainda: `avaliada: false`, sem `nota` (nunca `0`) e sem comentários. */
  avaliacao: { avaliada: boolean; nota?: string; avaliadaEm?: Date; comentarios: string[] };
}

/** O que uma tarefa pede para ser entregue e o estado atual da entrega do aluno. */
export interface RequisitosEntrega {
  /**
   * Id INTERNO da tarefa no Moodle (assign id, ex.: `286293`): o que as escritas (`salvarEntrega`, `finalizarEntrega`)
   * e o `mod_assign_get_submission_status` recebem. Não é o id que a pessoa/agente vê em `ver_curso`.
   */
  tarefaId: string;
  /** Id da ATIVIDADE (módulo do curso, `cmid`, ex.: `4258935`): o `tarefaId` público de `ver_curso` e das ferramentas MCP. */
  cmid: string;
  titulo: string;
  aceitaArquivo: boolean;
  aceitaTexto: boolean;
  maxArquivos?: number;
  maxBytesPorArquivo?: number;
  /**
   * Tipos aceitos como o Moodle guarda (`filetypeslist`), em minúsculas: extensões com ponto (`.pdf`), grupos (`document`),
   * MIME (`image/png`) ou `*`. `[]` = qualquer. Só uma lista feita só de extensões é conferida localmente.
   */
  extensoes: string[];
  abreEm?: Date;
  prazo?: Date;
  limite?: Date;
  exigeBotaoEnviar: boolean;
  emGrupo: boolean;
  exigeDeclaracao: boolean;
  estado: 'nova' | 'rascunho' | 'entregue';
  podeEditar: boolean;
  arquivosAtuais: { nome: string; tamanhoBytes: number }[];
  /** Se a entrega atual tem texto online (não o texto: só se existe). */
  temTextoAtual: boolean;
}

export interface ArquivoParaEnvio {
  nome: string;
  bytes: Uint8Array;
}

export interface RascunhoEnviado {
  itemId: string;
  arquivos: { nome: string; tamanhoBytes: number }[];
}

export interface EntregaTarefa {
  /** Id INTERNO da tarefa (assign id, o `RequisitosEntrega.tarefaId`), nunca o `cmid` de `ver_curso`. */
  tarefaId: string;
  itemId?: string;
  texto?: string;
}

export interface EstadoEntrega {
  /** Ausente = a escrita deu certo, mas a leitura do estado logo depois falhou (não é falha da escrita). */
  estado?: 'nova' | 'rascunho' | 'entregue';
  /**
   * Com o estado ausente: SÓ um código curto do porquê da leitura falhar (o `errorcode` do Moodle, `HTTP_<status>`, `REDE`,
   * `RESPOSTA_INVALIDA` ou `DESCONHECIDO`). Nunca mensagem, token, id ou conteúdo.
   */
  motivoLeitura?: string;
}

export interface PostagemFeita {
  discussaoId?: string;
  postId?: string;
}

/**
 * O que o calendário do Painel lê do SIGAA numa passada só: as turmas com dia e horário e os prazos (avaliações com data). O portal é
 * lido UMA vez e serve aos dois. `prazosCompletos: false` = a leitura dos prazos parou no meio (falha, ou acabou o orçamento de tempo):
 * as turmas continuam valendo e `prazos` traz só o que deu para ler.
 */
export interface AgendaSigaa {
  turmas: ClassSchedule[];
  prazos: PrazoVivo[];
  prazosCompletos: boolean;
}

export interface LiveSource {
  readonly provider: Provider;
  /** Matérias atuais da pessoa. `todas` inclui as passadas e futuras. */
  listarCursos(ctx: SourceContext, opts?: { todas?: boolean }): Promise<CursoVivo[]>;
  /**
   * Próximos prazos e eventos das matérias atuais. Moodle: 1 chamada (calendário). Classroom não tem calendário
   * agregado na API: 1 chamada por matéria ATIVA, com teto.
   */
  prazos(ctx: SourceContext): Promise<PrazoVivo[]>;
  /** Conteúdo de UMA matéria. */
  verCurso(ctx: SourceContext, cursoId: string): Promise<AtividadeViva[]>;
  /** Discussões de UM fórum. */
  verForum(ctx: SourceContext, forumId: string): Promise<DiscussaoViva[]>;
  /** Conteúdo de um anexo (`ref` vindo de `verCurso`/`verForum`). */
  baixar(ctx: SourceContext, ref: string): Promise<AttachmentContent>;
  /** Turmas do semestre com dia, horário, período e sala (só o SIGAA: 1 requisição, a página do portal que já se lê). */
  turmasComHorario?(ctx: SourceContext): Promise<ClassSchedule[]>;
  /** Turmas com horário e prazos do SIGAA com UMA leitura do portal (calendário do Painel). Ver `AgendaSigaa`. */
  agendaSigaa?(ctx: SourceContext, opts?: { orcamentoMs?: number }): Promise<AgendaSigaa>;
  /** Texto completo de UM aviso/notícia (`id` de um item `tipo: aviso` de `verCurso`). Hoje só o SIGAA. */
  verAviso?(ctx: SourceContext, avisoId: string): Promise<DiscussaoViva>;
  /** Frequência de cada turma do semestre. Hoje só o SIGAA. */
  frequencia?(ctx: SourceContext): Promise<FrequenciaViva[]>;
  /** Mensagens de UM tópico (inicial e respostas). Hoje só o Moodle: 1 chamada. */
  verTopico?(ctx: SourceContext, discussaoId: string): Promise<MensagemViva[]>;
  /** Participantes de UMA matéria, só nome e papéis (sem contato nem id). Hoje só o Moodle: 1 chamada. */
  listarParticipantes?(ctx: SourceContext, cursoId: string): Promise<ParticipanteVivo[]>;
  /** Publica em um fórum (nova discussão ou resposta). Hoje só o Moodle. Escrita: só com a permissão `moodle.forum_write`. */
  postarForum?(ctx: SourceContext, post: PostagemForum): Promise<PostagemFeita>;
  /** Lê o que a tarefa pede e o estado da entrega do aluno. Hoje só o Moodle. */
  /** `cmid`: o id da atividade em `ver_curso` (o `tarefaId` público). Devolve também o id interno (`tarefaId`). */
  requisitosEntrega?(ctx: SourceContext, cursoId: string, cmid: string): Promise<RequisitosEntrega>;
  /** Estado da entrega, nota e feedback do professor de uma tarefa. Só leitura. Hoje só o Moodle. `cmid`: o id público de `ver_curso`. */
  verTarefa?(ctx: SourceContext, cursoId: string, cmid: string): Promise<TarefaVista>;
  /** Sobe arquivos para a área de rascunho do aluno. */
  subirArquivosEntrega?(ctx: SourceContext, arquivos: ArquivoParaEnvio[]): Promise<RascunhoEnviado>;
  /** Grava a entrega (arquivos e/ou texto) como rascunho ou envio, conforme a tarefa. */
  salvarEntrega?(ctx: SourceContext, e: EntregaTarefa): Promise<EstadoEntrega>;
  /** Confirma o envio de um rascunho (botão "Enviar tarefa"). */
  /** `tarefaId`: o id INTERNO da tarefa (assign id, `RequisitosEntrega.tarefaId`). */
  finalizarEntrega?(ctx: SourceContext, tarefaId: string): Promise<EstadoEntrega>;
}

/** Fontes com leitura ao vivo disponíveis neste servidor. */
export class LiveSources {
  private readonly sources = new Map<Provider, LiveSource>();

  register(source: LiveSource): void {
    this.sources.set(source.provider, source);
  }

  get(provider: Provider): LiveSource | undefined {
    return this.sources.get(provider);
  }
}
