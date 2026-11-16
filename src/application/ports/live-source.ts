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
  titulo: string;
  mensagem?: string;
  autor?: string;
  publicadaEm?: Date;
  anexos: AnexoVivo[];
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
  /** Texto completo de UM aviso/notícia (`id` de um item `tipo: aviso` de `verCurso`). Hoje só o SIGAA. */
  verAviso?(ctx: SourceContext, avisoId: string): Promise<DiscussaoViva>;
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
