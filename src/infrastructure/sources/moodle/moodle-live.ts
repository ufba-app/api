import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import type {
  AnexoVivo,
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  LiveSource,
  PrazoVivo,
  TipoAtividade,
} from '../../../application/ports/live-source';
import { SourceError, type Provider, type SourceContext } from '../../../application/ports/source-gateway';
import { accessOf, type MoodleAccess } from './moodle-access';
import { MoodleAttachmentReader } from './moodle-attachment-reader';
import { MoodleClient, MoodleError, type FetchFn } from './moodle-client';
import { cleanUrl, type MoodleAssignment, type MoodleDiscussion, type MoodleFile } from './moodle-mapper';

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

function anexo(f: MoodleFile): AnexoVivo {
  return { nome: f.filename, mimeType: f.mimetype, tamanhoBytes: f.filesize, ref: cleanUrl(f.fileurl) };
}

/**
 * Moodle ao vivo. Chamadas por método (nunca varre curso por curso):
 * listarCursos 1 · prazos 1 · verCurso 2 · verForum 1 · baixar 1 (o arquivo).
 */
export class MoodleLive implements LiveSource {
  readonly provider: Provider = 'MOODLE';
  private readonly client: MoodleClient;
  private readonly files: MoodleAttachmentReader;

  constructor(fetchFn: FetchFn = fetch) {
    this.client = new MoodleClient(fetchFn);
    this.files = new MoodleAttachmentReader(fetchFn);
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

      const out: AtividadeViva[] = [];
      for (const s of sections) {
        for (const mod of s.modules ?? []) {
          if (mod.visible === 0 || mod.uservisible === false || mod.modname === 'label') continue;
          const contents = mod.contents ?? [];
          const tarefa = mod.modname === 'assign' ? tarefas.get(mod.id) : undefined;
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
            ],
            links: contents.filter((f) => f.type === 'url').map((f) => f.fileurl),
            forumId: mod.modname === 'forum' && mod.instance ? String(mod.instance) : undefined,
          });
        }
      }
      return out;
    });
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
        titulo: d.name,
        mensagem: htmlToText(d.message),
        autor: d.userfullname,
        publicadaEm: date(d.created),
        anexos: (Array.isArray(d.attachments) ? d.attachments : []).map(anexo),
      }));
    });
  }

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
