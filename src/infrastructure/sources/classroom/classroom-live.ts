import type {
  AnexoVivo,
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  LinkVivo,
  LiveSource,
  PrazoVivo,
} from '../../../application/ports/live-source';
import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { refreshTokenOf, translateErrors } from '../google/google-errors';
import type { GoogleHttp } from '../google/google-http';
import { appDaConta } from './classroom-link';
import type {
  GcAnnouncement,
  GcCourse,
  GcCourseWork,
  GcMaterial,
  GcMaterialPost,
} from './classroom-mapper';
import { AttachmentTooLargeError, DriveAttachmentReader, UnsupportedAttachmentError } from './drive-attachment-reader';

const BASE = 'https://classroom.googleapis.com/v1';

/** Teto de matérias consultadas em `prazos` (a API não tem calendário agregado: é 1 chamada por matéria). */
export const MAX_CURSOS_PRAZOS = 15;
/** Itens por chamada: só a primeira página, para o número de chamadas ser previsível. */
const PAGINA = 50;
const PARALELO = 4;

/** Ids do Classroom e do Drive: alfanuméricos com `_`/`-`; nada de barra, `?` ou `..`. */
const ID_OK = /^[A-Za-z0-9_-]{1,128}$/;

/** Onde o anexo foi publicado: tarefa, material ou aviso. */
const TIPOS = { t: 'courseWork', m: 'courseWorkMaterials', a: 'announcements' } as const;
type TipoPost = keyof typeof TIPOS;

/** `ref` de anexo: `<curso>:<t|m|a>:<post>:<arquivo do Drive>`. Diz onde conferir que o arquivo é anexo do Classroom. */
function refDe(cursoId: string, tipo: TipoPost, postId: string, driveId: string): string {
  return `${cursoId}:${tipo}:${postId}:${driveId}`;
}

function lerRef(ref: string): { cursoId: string; tipo: TipoPost; postId: string; driveId: string } {
  const [cursoId, tipo, postId, driveId, ...resto] = ref.split(':');
  if (resto.length || !(tipo in TIPOS) || ![cursoId, postId, driveId].every((x) => x && ID_OK.test(x))) {
    throw new SourceError('UNSUPPORTED_SCOPE', 'Referência de anexo do Classroom inválida: use o `ref` de ver_curso');
  }
  return { cursoId, tipo: tipo as TipoPost, postId, driveId };
}

/**
 * Classroom AO VIVO com o refresh token da conta. O cliente HTTP (app OAuth) é escolhido pelo domínio da conta:
 * @ufba.br → app interno; outras → app de convidados (o refresh token só renova com o app que o emitiu).
 * Chamadas por ferramenta (fora a renovação do access token, em cache):
 *  - listarCursos: 1;  prazos: 1 + 1 por matéria ATIVA (até `MAX_CURSOS_PRAZOS`);  verCurso: 3 em paralelo;
 *  - baixar: 3 (o post onde o arquivo foi anexado, para conferir; metadados e conteúdo do Drive).
 * Com `drive.readonly` o token leria o Drive inteiro: por isso `baixar` SÓ entrega arquivo anexado naquele post.
 */
export class ClassroomLive implements LiveSource {
  readonly provider = 'CLASSROOM' as const;
  private readonly now: () => Date;
  private readonly dominio: string;

  constructor(
    private readonly clientes: { ufba?: GoogleHttp; convidado?: GoogleHttp },
    opts: { now?: () => Date; dominio?: string } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.dominio = opts.dominio ?? 'ufba.br';
  }

  private http(ctx: SourceContext): GoogleHttp {
    const app = appDaConta(ctx.accountKey, this.dominio);
    const http = this.clientes[app];
    if (!http) {
      throw new SourceError(
        'UNAVAILABLE',
        app === 'ufba' ? 'Classroom @ufba.br não configurado neste servidor' : 'Classroom de convidados não configurado neste servidor',
      );
    }
    return http;
  }

  listarCursos(ctx: SourceContext, opts?: { todas?: boolean }): Promise<CursoVivo[]> {
    return translateErrors(async () =>
      (await this.cursos(ctx, !opts?.todas)).map((c) => ({
        id: c.id,
        nome: c.name,
        codigo: c.section || undefined,
        url: c.alternateLink,
      })),
    );
  }

  prazos(ctx: SourceContext): Promise<PrazoVivo[]> {
    return translateErrors(async () => {
      const http = this.http(ctx);
      const rt = refreshTokenOf(ctx);
      const cursos = (await this.cursos(ctx, true)).slice(0, MAX_CURSOS_PRAZOS);
      const hoje = this.now();
      hoje.setUTCHours(0, 0, 0, 0);
      const porCurso = await emLotes(cursos, PARALELO, async (c) => {
        const r = await http.getJson<{ courseWork?: GcCourseWork[] }>(rt, `${BASE}/courses/${c.id}/courseWork`, {
          pageSize: String(PAGINA),
          orderBy: 'dueDate desc',
        });
        return (r.courseWork ?? []).flatMap((w): PrazoVivo[] => {
          const quando = prazoDe(w);
          if (!quando || quando < hoje) return [];
          return [
            {
              id: w.id,
              titulo: w.title ?? 'Tarefa',
              quando,
              cursoId: c.id,
              cursoNome: c.name,
              tipo: 'tarefa',
              descricao: w.description || undefined,
              url: w.alternateLink,
            },
          ];
        });
      });
      return porCurso.flat().sort((a, b) => a.quando.getTime() - b.quando.getTime());
    });
  }

  verCurso(ctx: SourceContext, cursoId: string): Promise<AtividadeViva[]> {
    return translateErrors(async () => {
      if (!ID_OK.test(cursoId)) throw new SourceError('UNSUPPORTED_SCOPE', 'Id de matéria do Classroom inválido');
      const http = this.http(ctx);
      const rt = refreshTokenOf(ctx);
      const c = `${BASE}/courses/${cursoId}`;
      const p = { pageSize: String(PAGINA) };
      const [work, materiais, avisos] = await Promise.all([
        http.getJson<{ courseWork?: GcCourseWork[] }>(rt, `${c}/courseWork`, p),
        http.getJson<{ courseWorkMaterial?: GcMaterialPost[] }>(rt, `${c}/courseWorkMaterials`, p),
        http.getJson<{ announcements?: GcAnnouncement[] }>(rt, `${c}/announcements`, p),
      ]);
      return [
        ...(avisos.announcements ?? []).map((a) => ({
          id: a.id,
          tipo: 'aviso' as const,
          titulo: (a.text ?? '').split('\n')[0].slice(0, 120) || 'Aviso',
          descricao: a.text || undefined,
          url: a.alternateLink,
          ...materiais_(a.materials, (d) => refDe(cursoId, 'a', a.id, d)),
        })),
        ...(work.courseWork ?? []).map((w) => ({
          id: w.id,
          tipo: 'tarefa' as const,
          titulo: w.title ?? 'Tarefa',
          descricao: w.description || undefined,
          prazo: prazoDe(w),
          url: w.alternateLink,
          ...materiais_(w.materials, (d) => refDe(cursoId, 't', w.id, d)),
        })),
        ...(materiais.courseWorkMaterial ?? []).map((m) => ({
          id: m.id,
          tipo: 'material' as const,
          titulo: m.title ?? 'Material',
          descricao: m.description || undefined,
          url: m.alternateLink,
          ...materiais_(m.materials, (d) => refDe(cursoId, 'm', m.id, d)),
        })),
      ];
    });
  }

  async verForum(): Promise<DiscussaoViva[]> {
    throw new SourceError('UNSUPPORTED_SCOPE', 'O Classroom não tem fóruns: os avisos da turma vêm em ver_curso');
  }

  /**
   * Arquivo do Drive anexado a um post do Classroom. Antes de tocar o Drive, busca o post (1 chamada) e confere que
   * o arquivo está entre os anexos dele; senão recusa, mesmo que o token conseguisse ler.
   */
  baixar(ctx: SourceContext, ref: string): Promise<AttachmentContent> {
    return translateErrors(async () => {
      const { cursoId, tipo, postId, driveId } = lerRef(ref);
      const http = this.http(ctx);
      const rt = refreshTokenOf(ctx);
      const post = await http.getJson<{ materials?: GcMaterial[] }>(
        rt,
        `${BASE}/courses/${cursoId}/${TIPOS[tipo]}/${postId}`,
      );
      const anexado = (post.materials ?? []).some((m) => m.driveFile?.driveFile?.id === driveId);
      if (!anexado) {
        throw new SourceError('UNSUPPORTED_SCOPE', 'Esse arquivo não está anexado nesse post do Classroom');
      }
      try {
        return await new DriveAttachmentReader(http).read({ refreshToken: rt }, { externalId: driveId });
      } catch (e) {
        if (e instanceof AttachmentTooLargeError || e instanceof UnsupportedAttachmentError) {
          throw new SourceError('UNSUPPORTED_SCOPE', e.message);
        }
        throw e;
      }
    });
  }

  /** 1 chamada: matérias em que a pessoa é ALUNA (só as ativas, ou todas). */
  private async cursos(ctx: SourceContext, soAtivas: boolean): Promise<GcCourse[]> {
    const r = await this.http(ctx).getJson<{ courses?: GcCourse[] }>(refreshTokenOf(ctx), `${BASE}/courses`, {
      studentId: 'me',
      courseStates: soAtivas ? 'ACTIVE' : undefined,
      pageSize: '100',
    });
    return r.courses ?? [];
  }
}

function prazoDe(w: GcCourseWork): Date | undefined {
  const d = w.dueDate;
  if (!d?.year || !d.month || !d.day) return undefined;
  const t = w.dueTime;
  // dueTime é UTC; sem horário, vale o fim do dia.
  return new Date(Date.UTC(d.year, d.month - 1, d.day, t?.hours ?? 23, t?.minutes ?? 59, t?.seconds ?? 0));
}

/** Arquivos do Drive viram anexos (para `baixar`); vídeos, links e formulários, links para o navegador. */
function materiais_(
  materials: GcMaterial[] = [],
  ref: (driveId: string) => string,
): { anexos: AnexoVivo[]; abrirNoNavegador?: LinkVivo[] } {
  const anexos: AnexoVivo[] = [];
  const out: LinkVivo[] = [];
  for (const m of materials) {
    const f = m.driveFile?.driveFile;
    if (f?.id) anexos.push({ nome: f.title ?? 'arquivo', ref: ref(f.id) });
    else if (m.youTubeVideo?.alternateLink) out.push({ nome: m.youTubeVideo.title ?? 'vídeo', url: m.youTubeVideo.alternateLink });
    else if (m.link?.url) out.push({ nome: m.link.title ?? m.link.url, url: m.link.url });
    else if (m.form?.formUrl) out.push({ nome: m.form.title ?? 'formulário', url: m.form.formUrl });
  }
  return out.length ? { anexos, abrirNoNavegador: out } : { anexos };
}

/** Executa com no máximo `n` em paralelo, preservando a ordem. */
async function emLotes<T, R>(itens: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, itens.length) }, async () => {
      while (i < itens.length) {
        const k = i++;
        out[k] = await fn(itens[k]);
      }
    }),
  );
  return out;
}
