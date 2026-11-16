import type { AttachmentContent } from './attachment-reader';
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
  /** Texto completo de UM aviso/notícia (`id` de um item `tipo: aviso` de `verCurso`). Hoje só o SIGAA. */
  verAviso?(ctx: SourceContext, avisoId: string): Promise<DiscussaoViva>;
  /** Frequência de cada turma do semestre. Hoje só o SIGAA. */
  frequencia?(ctx: SourceContext): Promise<FrequenciaViva[]>;
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
