import { Logger } from '@nestjs/common';
import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import type {
  AnexoVivo,
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  LiveSource,
  MensagemViva,
  ParticipanteVivo,
  EntregaTarefa,
  EstadoEntrega,
  PostagemFeita,
  PostagemForum,
  RequisitosEntrega,
  TarefaVista,
  PrazoVivo,
  ArquivoParaEnvio,
  RascunhoEnviado,
  TipoAtividade,
} from '../../../application/ports/live-source';
import { SourceError, type Provider, type SourceContext } from '../../../application/ports/source-gateway';
import { DRIVE_KIND_NAME, extractDriveLinks, parseDriveLink } from '../../../domain/drive/drive-link';
import type { DriveRefs } from '../drive/drive-refs';
import { accessOf, type MoodleAccess } from './moodle-access';
import { MoodleAttachmentReader } from './moodle-attachment-reader';
import { MoodleClient, MoodleError, nomeSeguro, type FetchFn } from './moodle-client';
import { cleanUrl, type MoodleAssignment, type MoodleDiscussion, type MoodleFile } from './moodle-mapper';

/** Teto de arquivos HTML (capítulos de livro, recursos HTML, páginas) baixados por `verCurso` só para achar links do Drive. */
export const MAX_HTML_LEITURAS = 12;
/** HTML maior que isso não é lido. */
const MAX_HTML_BYTES = 512 * 1024;
const PARALELO_HTML = 4;

interface MoodlePageRow {
  coursemodule?: number;
  content?: string;
}

interface MoodleAssignmentConfig {
  /** Id interno da tarefa (assign id): o que as escritas e o status recebem. */
  id: number;
  /** Id do módulo do curso (a atividade em `ver_curso`): o `tarefaId` público. */
  cmid: number;
  name: string;
  duedate?: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  submissiondrafts?: number;
  teamsubmission?: number;
  requiresubmissionstatement?: number;
  configs?: { plugin: string; subtype?: string; name: string; value: string }[];
}
interface MoodleSubmissionStatus {
  lastattempt?: {
    canedit?: boolean;
    graded?: boolean;
    extensionduedate?: number | null;
    submission?: {
      status?: string;
      timemodified?: number;
      plugins?: {
        type: string;
        fileareas?: { area: string; files?: { filename: string; filesize: number }[] }[];
        editorfields?: { name?: string; text?: string }[];
      }[];
    };
  };
  /** Ausente enquanto não há nota. `gradefordisplay` vem em HTML (`100,00&nbsp;/&nbsp;100,00`). */
  feedback?: {
    gradefordisplay?: string;
    gradeddate?: number;
    plugins?: { type: string; editorfields?: { name?: string; text?: string }[] }[];
  };
}

interface TimelineCourse {
  id: number;
  fullname: string;
  shortname?: string;
  viewurl?: string;
}
interface LiveModule {
  id: number;
  instance?: number;
  name: string;
  modname: string;
  url?: string;
  description?: string;
  contents?: MoodleFile[];
  visible?: number;
  uservisible?: boolean;
}
interface LiveSection {
  id: number;
  name: string;
  modules?: LiveModule[];
}
interface UpcomingEvent {
  id: number;
  name: string;
  description?: string;
  timestart: number;
  modulename?: string;
  eventtype?: string;
  url?: string;
  course?: { id: number; fullname?: string };
}
type Discussion = MoodleDiscussion & { userfullname?: string };
/** Participante de `core_enrol_get_enrolled_users` (só os campos usados). */
interface MoodleEnrolledUser {
  id: number;
  fullname: string;
  roles?: Array<{ shortname?: string }>;
}
/** Mensagem de `mod_forum_get_discussion_posts` (só os campos usados). */
interface MoodlePost {
  id: number;
  /** Id da mensagem pai (0 na inicial). Na resposta real do Moodle o campo é `parentid`; `parent` fica como reserva. */
  parentid?: number;
  parent?: number;
  author?: { fullname?: string };
  userfullname?: string;
  created?: number;
  message?: string;
  attachments?: MoodleFile[];
}

const TIPO_POR_MODULO: Record<string, TipoAtividade> = {
  assign: 'tarefa',
  quiz: 'prova',
  forum: 'forum',
  resource: 'material',
  folder: 'material',
  url: 'material',
  page: 'material',
  book: 'material',
};

const date = (s?: number | null) => (s ? new Date(s * 1000) : undefined);

/** HTML do Moodle → texto legível (para o modelo ler sem marcação). */
export function htmlToText(html?: string): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

/** Texto digitado → HTML do Moodle: escapa tudo e faz um parágrafo por linha (linha vazia não vira parágrafo). */
export function textoParaHtml(texto: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return texto
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => `<p>${esc(l)}</p>`)
    .join('');
}

/** Id do Moodle: só dígitos, sem zero à esquerda nem zero (barra '', '0', '1e3', '-1', '0x10'). */
function idMoodle(valor: string, nome: string): number {
  if (!/^[1-9]\d{0,14}$/.test(valor)) throw new SourceError('UNSUPPORTED_SCOPE', `${nome} inválido`);
  return Number(valor);
}

function estadoDe(status?: string): RequisitosEntrega['estado'] {
  return status === 'submitted' ? 'entregue' : status === 'draft' ? 'rascunho' : 'nova';
}

/** Pausas entre as tentativas de ler o estado depois de gravar (3 tentativas no total). */
const PAUSAS_LEITURA_MS = [400, 1200] as const;

/**
 * Código curto e seguro do porquê de uma leitura falhar: só o `errorcode` do Moodle (se tiver cara de código), `HTTP_<status>`,
 * `REDE`, `RESPOSTA_INVALIDA` ou `DESCONHECIDO`. Nunca a mensagem (pode ter conteúdo), o token, ids ou a URL.
 */
function motivoDaFalha(e: unknown): string {
  if (e instanceof MoodleError) {
    if (e.errorCode && /^[A-Za-z0-9_]{1,64}$/.test(e.errorCode)) return e.errorCode;
    const http = /^Moodle HTTP (\d{3}) /.exec(e.message);
    return http ? `HTTP_${http[1]}` : 'DESCONHECIDO';
  }
  if (e instanceof SyntaxError) return 'RESPOSTA_INVALIDA';
  const nome = (e as { name?: unknown })?.name;
  if (e instanceof TypeError || nome === 'AbortError' || nome === 'TimeoutError') return 'REDE';
  return 'DESCONHECIDO';
}

function anexo(f: MoodleFile): AnexoVivo {
  return { nome: f.filename, mimeType: f.mimetype, tamanhoBytes: f.filesize, ref: cleanUrl(f.fileurl) };
}

/**
 * Moodle ao vivo. Chamadas por método (nunca varre curso por curso):
 * listarCursos 1 · prazos 1 · verCurso 2 (+1 se houver módulo "page", +até 12 arquivos HTML de livro/recurso/página, só para achar
 * links do Drive) · verForum 1 · baixar 1 (o arquivo).
 */
export class MoodleLive implements LiveSource {
  readonly provider: Provider = 'MOODLE';
  private readonly client: MoodleClient;
  private readonly files: MoodleAttachmentReader;

  /** `drive` liga os arquivos do Drive linkados no curso (assina os `ref`); sem ele, os links ficam só como links. */
  /** `opcoes.esperar`: a pausa entre tentativas da leitura do estado depois de gravar (injetável nos testes). */
  constructor(
    fetchFn: FetchFn = fetch,
    private readonly drive?: DriveRefs,
    private readonly opcoes: { esperar?: (ms: number) => Promise<void> } = {},
  ) {
    this.client = new MoodleClient(fetchFn);
    this.files = new MoodleAttachmentReader(fetchFn);
  }

  /**
   * Links do Drive/Docs que o professor pôs no conteúdo (HTML e URLs) viram anexos com `ref` ASSINADO e preso à pessoa:
   * só o que apareceu no curso desta pessoa pode ser baixado depois.
   */
  private driveAnexos(userId: string, html: string | undefined, urls: readonly string[] = []): AnexoVivo[] {
    if (!this.drive) return [];
    return extractDriveLinks(html, urls).map((l) => ({
      nome: l.label ?? DRIVE_KIND_NAME[l.kind],
      ...(l.kind === 'sheet'
        ? { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        : l.kind === 'file'
          ? {}
          : l.kind === 'folder'
            ? { mimeType: 'application/vnd.google-apps.folder' }
            : { mimeType: 'application/pdf' }),
      ref: this.drive!.sign(userId, l),
    }));
  }

  listarCursos(ctx: SourceContext, opts?: { todas?: boolean }): Promise<CursoVivo[]> {
    return this.run(ctx, async (m) => {
      const res = await this.client.call<{ courses?: TimelineCourse[] }>(
        m,
        'core_course_get_enrolled_courses_by_timeline_classification',
        { classification: opts?.todas ? 'all' : 'inprogress' },
      );
      return (res.courses ?? []).map((c) => ({
        id: String(c.id),
        nome: c.fullname,
        codigo: c.shortname,
        url: c.viewurl,
      }));
    });
  }

  prazos(ctx: SourceContext): Promise<PrazoVivo[]> {
    return this.run(ctx, async (m) => {
      const res = await this.client.call<{ events?: UpcomingEvent[] }>(
        m,
        'core_calendar_get_calendar_upcoming_view',
      );
      return (res.events ?? []).map((e) => ({
        id: String(e.id),
        titulo: e.name,
        quando: new Date(e.timestart * 1000),
        cursoId: e.course ? String(e.course.id) : undefined,
        cursoNome: e.course?.fullname,
        tipo: e.modulename ? (TIPO_POR_MODULO[e.modulename] ?? e.modulename) : e.eventtype,
        descricao: htmlToText(e.description),
        url: e.url,
      }));
    });
  }

  verCurso(ctx: SourceContext, cursoId: string): Promise<AtividadeViva[]> {
    return this.run(ctx, async (m) => {
      const id = Number(cursoId);
      if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'cursoId inválido');
      const [sections, assigns] = await Promise.all([
        this.client.call<LiveSection[]>(m, 'core_course_get_contents', { courseid: id }),
        this.client.call<{ courses?: { assignments: MoodleAssignment[] }[] }>(m, 'mod_assign_get_assignments', {
          'courseids[0]': id,
        }),
      ]);
      const tarefas = new Map<number, MoodleAssignment>();
      for (const c of assigns.courses ?? []) for (const a of c.assignments) if (a.cmid) tarefas.set(a.cmid, a);
      // Corpo de páginas, capítulos de livro e recursos HTML: é onde o professor costuma pôr o link do Drive.
      const corpos = await this.corposHtml(ctx, m, id, sections);

      const out: AtividadeViva[] = [];
      for (const s of sections) {
        for (const mod of s.modules ?? []) {
          if (mod.visible === 0 || mod.uservisible === false) continue;
          const contents = mod.contents ?? [];
          const tarefa = mod.modname === 'assign' ? tarefas.get(mod.id) : undefined;
          const htmlDescricao = tarefa?.intro ?? mod.description;
          const doDrive = this.driveAnexos(
            ctx.userId,
            [htmlDescricao, ...(corpos.get(mod.id) ?? [])].join(' '),
            contents.filter((f) => f.type === 'url').map((f) => f.fileurl),
          );
          // Rótulos (texto solto na página do curso) só entram se trouxerem arquivo do Drive.
          if (mod.modname === 'label' && doDrive.length === 0) continue;
          out.push({
            id: String(mod.id),
            tipo: TIPO_POR_MODULO[mod.modname] ?? 'outro',
            titulo: mod.name,
            secao: s.name,
            descricao: htmlToText(tarefa?.intro ?? mod.description),
            prazo: date(tarefa?.duedate),
            url: mod.url,
            anexos: [
              ...contents.filter((f) => f.type !== 'url').map(anexo),
              ...(tarefa?.introattachments ?? []).map(anexo),
              ...doDrive,
            ],
            // Link do Drive que virou anexo sai de `links`: o agente deve usar o `ref` (o link direto pede login).
            links: contents
              .filter((f) => f.type === 'url' && !(this.drive && parseDriveLink(f.fileurl)))
              .map((f) => f.fileurl),
            forumId: mod.modname === 'forum' && mod.instance ? String(mod.instance) : undefined,
          });
        }
      }
      return out;
    });
  }

  /**
   * HTML dos módulos que guardam o texto fora da descrição, por id do módulo (`cmid`): `page` (1 chamada `mod_page_get_pages_by_courses`
   * para o curso todo; se falhar, baixa o index.html de cada página), `book` (capítulos) e `resource` HTML (arquivo). Melhor esforço:
   * qualquer falha aqui só deixa de achar links, nunca derruba `verCurso`. Teto de 12 arquivos e 512 KB cada.
   */
  private async corposHtml(ctx: SourceContext, m: MoodleAccess, courseId: number, sections: LiveSection[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (!this.drive) return out; // só serve para achar links do Drive
    const visible = sections.flatMap((s) => s.modules ?? []).filter((mod) => mod.visible !== 0 && mod.uservisible !== false);
    const add = (cmid: number, html: string) => out.set(cmid, [...(out.get(cmid) ?? []), html]);
    const isHtml = (f: MoodleFile) => f.type !== 'url' && (f.mimetype?.toLowerCase().startsWith('text/html') || /\.html?$/i.test(f.filename)) && (f.filesize ?? 0) <= MAX_HTML_BYTES;

    const pages = visible.filter((mod) => mod.modname === 'page');
    let pagesViaWs = false;
    if (pages.length > 0) {
      try {
        const r = await this.client.call<{ pages?: MoodlePageRow[] }>(m, 'mod_page_get_pages_by_courses', { 'courseids[0]': courseId });
        for (const p of r.pages ?? []) if (p.coursemodule && p.content) add(p.coursemodule, p.content);
        pagesViaWs = true;
      } catch {
        // Função fora do serviço do AVA ou sem permissão: cai no index.html de cada página.
      }
    }
    const files: Array<{ cmid: number; file: MoodleFile }> = [];
    for (const mod of visible) {
      const wanted = mod.modname === 'book' || mod.modname === 'resource' || (mod.modname === 'page' && !pagesViaWs);
      if (!wanted) continue;
      for (const f of mod.contents ?? []) if (isHtml(f)) files.push({ cmid: mod.id, file: f });
    }
    const queue = files.slice(0, MAX_HTML_LEITURAS);
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        try {
          // O leitor só aceita URL do Moodle da própria conta e acrescenta o token (nunca logado).
          const r = await this.files.read(ctx, cleanUrl(it.file.fileurl));
          if (r.content.length <= MAX_HTML_BYTES) add(it.cmid, r.content.toString('utf8'));
        } catch {
          // melhor esforço
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALELO_HTML, queue.length) }, worker));
    return out;
  }

  verForum(ctx: SourceContext, forumId: string): Promise<DiscussaoViva[]> {
    return this.run(ctx, async (m) => {
      const id = Number(forumId);
      if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'forumId inválido');
      const res = await this.client.call<{ discussions?: Discussion[] }>(m, 'mod_forum_get_forum_discussions', {
        forumid: id,
      });
      return (res.discussions ?? []).map((d) => ({
        id: String(d.discussion ?? d.id),
        postId: String(d.id),
        titulo: d.name,
        mensagem: htmlToText(d.message),
        autor: d.userfullname,
        publicadaEm: date(d.created),
        anexos: [...(Array.isArray(d.attachments) ? d.attachments : []).map(anexo), ...this.driveAnexos(ctx.userId, d.message)],
      }));
    });
  }

  /**
   * Mensagens de UM tópico, com as respostas (`mod_forum_get_discussion_posts`, 1 chamada). `verForum` só traz a mensagem
   * inicial de cada tópico; para ler a conversa, pede-se o tópico. Ordem cronológica; `respostaA` liga cada resposta à sua mensagem.
   */
  verTopico(ctx: SourceContext, discussaoId: string): Promise<MensagemViva[]> {
    return this.run(ctx, async (m) => {
      const id = Number(discussaoId);
      if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'discussaoId inválido');
      const res = await this.client.call<{ posts?: MoodlePost[] }>(m, 'mod_forum_get_discussion_posts', {
        discussionid: id,
        sortby: 'created',
        sortdirection: 'ASC',
      });
      return (res.posts ?? []).map((p) => ({
        postId: String(p.id),
        ...((p.parentid ?? p.parent) ? { respostaA: String(p.parentid ?? p.parent) } : {}),
        autor: p.author?.fullname ?? p.userfullname,
        publicadaEm: date(p.created),
        mensagem: htmlToText(p.message),
        anexos: [...(Array.isArray(p.attachments) ? p.attachments : []).map(anexo), ...this.driveAnexos(ctx.userId, p.message)],
      }));
    });
  }

  /**
   * Participantes da matéria (`core_enrol_get_enrolled_users`, 1 chamada). Devolve só nome e papéis: o resto da resposta
   * (e-mail, id, imagem) não sai daqui.
   */
  listarParticipantes(ctx: SourceContext, cursoId: string): Promise<ParticipanteVivo[]> {
    return this.run(ctx, async (m) => {
      const id = Number(cursoId);
      if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'cursoId inválido');
      const res = await this.client.call<MoodleEnrolledUser[]>(m, 'core_enrol_get_enrolled_users', { courseid: id });
      return (Array.isArray(res) ? res : []).map((u) => ({
        nome: u.fullname,
        papeis: (u.roles ?? []).map((r) => r.shortname).filter((s): s is string => typeof s === 'string'),
      }));
    });
  }

  /**
   * Publica no fórum: nova discussão (`mod_forum_add_discussion`, pelo `forumId`) ou resposta a uma mensagem
   * (`mod_forum_add_discussion_post`, pelo `postId` de `verForum`). 1 chamada. O texto vai como HTML escapado, um parágrafo por linha.
   */
  postarForum(ctx: SourceContext, post: PostagemForum): Promise<PostagemFeita> {
    return this.run(ctx, async (m) => {
      const mensagem = textoParaHtml(post.mensagem);
      if (post.postId !== undefined) {
        const id = Number(post.postId);
        if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'postId inválido');
        const res = await this.client.call<{ postid?: number }>(m, 'mod_forum_add_discussion_post', {
          postid: id,
          subject: post.titulo,
          message: mensagem,
        });
        return { postId: res.postid !== undefined ? String(res.postid) : undefined };
      }
      const id = Number(post.forumId);
      if (!Number.isInteger(id)) throw new SourceError('UNSUPPORTED_SCOPE', 'forumId inválido');
      const res = await this.client.call<{ discussionid?: number }>(m, 'mod_forum_add_discussion', {
        forumid: id,
        subject: post.titulo,
        message: mensagem,
      });
      return { discussaoId: res.discussionid !== undefined ? String(res.discussionid) : undefined };
    });
  }

  /** Acha a tarefa do curso pelo `cmid` (nunca pelo id interno) e lê o status da entrega do aluno. 2 chamadas. */
  private async lerTarefaEStatus(m: MoodleAccess, cursoId: string, cmid: string) {
    const curso = idMoodle(cursoId, 'cursoId');
    const modulo = idMoodle(cmid, 'tarefaId');
    const res = await this.client.call<{ courses?: { assignments?: MoodleAssignmentConfig[] }[] }>(
      m,
      'mod_assign_get_assignments',
      { 'courseids[0]': curso },
    );
    let a: MoodleAssignmentConfig | undefined;
    for (const c of res.courses ?? []) a ??= (c.assignments ?? []).find((x) => x.cmid === modulo);
    if (!a) throw new SourceError('UNSUPPORTED_SCOPE', 'tarefa não encontrada neste curso');
    // Daqui em diante o Moodle quer o id interno da tarefa (assign id), não o cmid.
    const status = await this.client.call<MoodleSubmissionStatus>(m, 'mod_assign_get_submission_status', { assignid: a.id });
    return { a, status };
  }

  /** Estado da entrega, nota e feedback do professor. Só lê (2 chamadas). `cmid` = id da atividade em `ver_curso`. */
  verTarefa(ctx: SourceContext, cursoId: string, cmid: string): Promise<TarefaVista> {
    return this.run(ctx, async (m) => {
      const { a, status } = await this.lerTarefaEStatus(m, cursoId, cmid);
      const sub = status.lastattempt?.submission;
      const enviadoEm = sub?.timemodified ? date(sub.timemodified) : undefined;
      const limite = status.lastattempt?.extensionduedate || a.duedate;
      const arquivosAtuais = (sub?.plugins ?? [])
        .filter((p) => p.type === 'file')
        .flatMap((p) => p.fileareas ?? [])
        .filter((area) => area.area === 'submission_files')
        .flatMap((area) => (area.files ?? []).map((f) => ({ nome: f.filename, tamanhoBytes: f.filesize })));
      const temTextoAtual = (sub?.plugins ?? []).some(
        (p) => p.type === 'onlinetext' && (p.editorfields ?? []).some((f) => typeof f.text === 'string' && f.text.trim() !== ''),
      );
      const fb = status.feedback;
      const nota = htmlToText(fb?.gradefordisplay)?.replace(/\s+/g, ' ');
      const comentarios = (fb?.plugins ?? [])
        .filter((p) => p.type === 'comments')
        .flatMap((p) => p.editorfields ?? [])
        .map((f) => htmlToText(f.text))
        .filter((t): t is string => t !== undefined);
      const avaliada = status.lastattempt?.graded === true;
      return {
        tarefaId: String(a.cmid),
        titulo: a.name,
        ...(a.duedate ? { prazo: date(a.duedate) } : {}),
        estado: estadoDe(sub?.status),
        ...(enviadoEm ? { enviadoEm } : {}),
        atrasada: enviadoEm !== undefined && !!limite && enviadoEm.getTime() > limite * 1000,
        arquivosAtuais,
        temTextoAtual,
        avaliacao: {
          avaliada,
          ...(avaliada && nota ? { nota } : {}),
          ...(avaliada && fb?.gradeddate ? { avaliadaEm: date(fb.gradeddate) } : {}),
          comentarios: avaliada ? comentarios : [],
        },
      };
    });
  }

  /**
   * Lê o que a tarefa pede (`mod_assign_get_assignments` do curso) e o estado da entrega do aluno
   * (`mod_assign_get_submission_status`). 2 chamadas. Timestamps do Moodle são em segundos; `0` = ausente.
   * Acha a tarefa pelo `cmid` (o id da atividade em `ver_curso`), nunca pelo id interno; devolve os dois.
   */
  requisitosEntrega(ctx: SourceContext, cursoId: string, cmid: string): Promise<RequisitosEntrega> {
    return this.run(ctx, async (m) => {
      const { a, status } = await this.lerTarefaEStatus(m, cursoId, cmid);

      const cfg = (plugin: string, name: string): string | undefined =>
        (a.configs ?? []).find((c) => c.plugin === plugin && c.name === name)?.value;
      const segundos = (v?: number): Date | undefined => (v ? new Date(v * 1000) : undefined);
      const num = (v?: string): number | undefined => {
        const n = v === undefined || v === '' ? NaN : Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const sub = status.lastattempt?.submission;
      const estado = estadoDe(sub?.status);
      const arquivosAtuais: { nome: string; tamanhoBytes: number }[] = [];
      // Só se existe texto online: o texto em si não sai daqui.
      const temTextoAtual = (sub?.plugins ?? []).some(
        (p) => p.type === 'onlinetext' && (p.editorfields ?? []).some((f) => typeof f.text === 'string' && f.text.trim() !== ''),
      );
      for (const p of sub?.plugins ?? []) {
        if (p.type !== 'file') continue;
        for (const area of p.fileareas ?? []) {
          if (area.area !== 'submission_files') continue;
          for (const f of area.files ?? []) arquivosAtuais.push({ nome: f.filename, tamanhoBytes: f.filesize });
        }
      }
      return {
        tarefaId: String(a.id),
        cmid: String(a.cmid),
        titulo: a.name,
        aceitaArquivo: cfg('file', 'enabled') === '1',
        aceitaTexto: cfg('onlinetext', 'enabled') === '1',
        maxArquivos: num(cfg('file', 'maxfilesubmissions')),
        maxBytesPorArquivo: num(cfg('file', 'maxsubmissionsizebytes')) || undefined, // 0 = limite do site/curso
        // Extensões, grupos (`document`) ou MIME, como o Moodle guarda: quem confere é o EntregaService (só extensões).
        extensoes: (cfg('file', 'filetypeslist') ?? '')
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
        abreEm: segundos(a.allowsubmissionsfromdate),
        prazo: segundos(a.duedate),
        limite: segundos(a.cutoffdate),
        exigeBotaoEnviar: a.submissiondrafts === 1,
        emGrupo: a.teamsubmission === 1,
        exigeDeclaracao: a.requiresubmissionstatement === 1,
        estado,
        podeEditar: status.lastattempt?.canedit === true,
        arquivosAtuais,
        temTextoAtual,
      };
    });
  }

  /** Sobe os arquivos para o rascunho do aluno (um POST só); os nomes passam por `nomeSeguro`. */
  subirArquivosEntrega(ctx: SourceContext, arquivos: ArquivoParaEnvio[]): Promise<RascunhoEnviado> {
    return this.run(ctx, (m) => this.client.upload(m, arquivos.map((a) => ({ nome: nomeSeguro(a.nome), bytes: a.bytes }))));
  }

  /** Grava a entrega (arquivos e/ou texto). `[]` = ok; lista não vazia = avisos do Moodle = falha. Devolve o estado lido depois. */
  salvarEntrega(ctx: SourceContext, e: EntregaTarefa): Promise<EstadoEntrega> {
    return this.run(ctx, async (m) => {
      const tarefa = idMoodle(e.tarefaId, 'tarefaId');
      // Sem arquivos nem texto o Moodle trataria como entrega vazia e poderia apagar o que já existe.
      if (e.itemId === undefined && e.texto === undefined) {
        throw new SourceError('UNSUPPORTED_SCOPE', 'A entrega precisa de arquivos ou texto');
      }
      const params: Record<string, string | number> = { assignmentid: tarefa };
      if (e.itemId !== undefined) params['plugindata[files_filemanager]'] = idMoodle(e.itemId, 'itemId');
      if (e.texto !== undefined) {
        params['plugindata[onlinetext_editor][text]'] = textoParaHtml(e.texto);
        params['plugindata[onlinetext_editor][format]'] = 1;
        params['plugindata[onlinetext_editor][itemid]'] = 0;
      }
      const avisos = await this.client.call<unknown>(m, 'mod_assign_save_submission', params);
      this.exigirSemAvisos(m, avisos, 'salvar a entrega');
      return this.lerEstadoDepoisDeGravar(m, tarefa);
    });
  }

  /** Confirma o envio do rascunho ("Enviar tarefa"). */
  finalizarEntrega(ctx: SourceContext, tarefaId: string): Promise<EstadoEntrega> {
    return this.run(ctx, async (m) => {
      const tarefa = idMoodle(tarefaId, 'tarefaId');
      const avisos = await this.client.call<unknown>(m, 'mod_assign_submit_for_grading', {
        assignmentid: tarefa,
        acceptsubmissionstatement: 0,
      });
      this.exigirSemAvisos(m, avisos, 'enviar a tarefa');
      return this.lerEstadoDepoisDeGravar(m, tarefa);
    });
  }

  /** A escrita responde uma lista de avisos: `[]` = ok. Outra coisa é falha; o texto do Moodle sai sem o token e curto. */
  private exigirSemAvisos(m: MoodleAccess, avisos: unknown, acao: string): void {
    if (!Array.isArray(avisos)) throw new SourceError('UNAVAILABLE', `O Moodle respondeu algo inesperado ao ${acao}`);
    if (avisos.length === 0) return;
    const token = m.token.reveal();
    const msg = avisos
      .map((w) => (w && typeof w === 'object' && typeof (w as { message?: unknown }).message === 'string' ? (w as { message: string }).message : ''))
      .filter(Boolean)
      .join('; ')
      .split(token)
      .join('***')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .slice(0, 300);
    throw new SourceError('UNAVAILABLE', `O Moodle não aceitou ${acao}${msg ? `: ${msg}` : ''}`);
  }

  /**
   * Depois de uma escrita que deu certo, a falha da leitura não é falha da escrita: tenta até 3 vezes (pausas de 400 ms e 1200 ms)
   * e, se nenhuma der, devolve o estado ausente com `motivoLeitura` (só um código) e um aviso fixo no log. Nunca regrava.
   */
  private async lerEstadoDepoisDeGravar(m: MoodleAccess, tarefa: number): Promise<EstadoEntrega> {
    const esperar = this.opcoes.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let motivo = 'DESCONHECIDO';
    for (let tentativa = 0; tentativa < PAUSAS_LEITURA_MS.length + 1; tentativa++) {
      if (tentativa > 0) await esperar(PAUSAS_LEITURA_MS[tentativa - 1]);
      try {
        const status: unknown = await this.client.call<unknown>(m, 'mod_assign_get_submission_status', { assignid: tarefa });
        if (!status || typeof status !== 'object' || Array.isArray(status)) {
          motivo = 'RESPOSTA_INVALIDA';
          continue;
        }
        return { estado: estadoDe((status as MoodleSubmissionStatus).lastattempt?.submission?.status) };
      } catch (e) {
        motivo = motivoDaFalha(e);
      }
    }
    MoodleLive.log.warn(`Leitura do estado da entrega falhou depois de gravar: motivo=${motivo} tentativas=${PAUSAS_LEITURA_MS.length + 1}`);
    return { motivoLeitura: motivo };
  }

  private static readonly log = new Logger('MoodleLive');

  baixar(ctx: SourceContext, ref: string): Promise<AttachmentContent> {
    return this.run(ctx, async () => {
      // O leitor recusa URL de outro host: o token só vai para o Moodle da própria conta.
      const f = await this.files.read(ctx, ref);
      return { bytes: new Uint8Array(f.content), mimeType: f.mimeType, fileName: f.fileName };
    });
  }

  /** Traduz erros do Moodle (token recusado vira REAUTH_NEEDED). Mensagens já vêm sem o token. */
  private async run<T>(ctx: SourceContext, fn: (m: MoodleAccess) => Promise<T>): Promise<T> {
    try {
      return await fn(accessOf(ctx));
    } catch (e) {
      if (e instanceof SourceError) throw e;
      if (e instanceof MoodleError) {
        const reauth = e.errorCode === 'invalidtoken' || e.errorCode === 'accessexception';
        throw new SourceError(reauth ? 'REAUTH_NEEDED' : 'UNAVAILABLE', e.message);
      }
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      throw new SourceError('UNAVAILABLE', `Não consegui falar com o Moodle${cause ? ` (${cause})` : ''}`);
    }
  }
}
