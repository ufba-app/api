import { Controller, Get, Param, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ConsultaService, type Quem } from '../../application/live/consulta.service';
import type {
  AnexoVivo,
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  PrazoVivo,
  TipoAtividade,
} from '../../application/ports/live-source';
import type { Provider } from '../../application/ports/source-gateway';
import { AccountQuery, AttachmentQuery, CoursesQuery, parseInput } from '../../application/web/contract';
import { ApiError, invalidRequest, sessionExpired, type WebPrincipal } from '../../application/web/web-api';
import { contentDisposition } from '../rest/download.controller';
import { ApiErrorFilter } from './api-error.filter';
import { DataGuard, Principal } from './web-auth';

const PROVIDERS: Record<string, Provider> = { sigaa: 'SIGAA', moodle: 'MOODLE', classroom: 'CLASSROOM' };
const SOURCES: Partial<Record<Provider, string>> = { SIGAA: 'sigaa', MOODLE: 'moodle', CLASSROOM: 'classroom' };

const TYPES: Record<TipoAtividade, string> = {
  tarefa: 'assignment',
  prova: 'exam',
  material: 'material',
  forum: 'forum',
  aviso: 'announcement',
  outro: 'other',
};

function provider(source: string): Provider {
  const p = PROVIDERS[source];
  if (!p) throw new ApiError(400, 'invalid_request', 'Fonte inválida: use sigaa, moodle ou classroom.');
  return p;
}

function quem(p: WebPrincipal | null): Quem {
  if (!p) throw sessionExpired();
  return p.clientId
    ? { userId: p.userId, cliente: { clientId: p.clientId, ...(p.chave ? { chave: p.chave } : {}) } }
    : { userId: p.userId };
}

const iso = (d?: Date) => (d ? d.toISOString() : undefined);
const account = (a?: string) => (a && a.trim() ? a : undefined);

/** Sem campos `undefined` no JSON (só some). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const attachment = (a: AnexoVivo) => compact({ name: a.nome, mimeType: a.mimeType, sizeBytes: a.tamanhoBytes, ref: a.ref });

export const toCourse = (c: CursoVivo) => compact({ id: c.id, name: c.nome, code: c.codigo, url: c.url });

export const toDeadline = (d: PrazoVivo) =>
  compact({
    id: d.id,
    title: d.titulo,
    dueAt: d.quando.toISOString(),
    courseId: d.cursoId,
    courseName: d.cursoNome,
    type: d.tipo,
    description: d.descricao,
    url: d.url,
  });

export const toActivity = (a: AtividadeViva) =>
  compact({
    id: a.id,
    type: TYPES[a.tipo] ?? 'other',
    title: a.titulo,
    section: a.secao,
    description: a.descricao,
    dueAt: iso(a.prazo),
    url: a.url,
    attachments: a.anexos.map(attachment),
    links: a.links,
    openInBrowser: a.abrirNoNavegador?.map((l) => ({ name: l.nome, url: l.url })),
    forumId: a.forumId,
  });

export const toDiscussion = (d: DiscussaoViva) =>
  compact({
    id: d.id,
    title: d.titulo,
    message: d.mensagem,
    author: d.autor,
    publishedAt: iso(d.publicadaEm),
    attachments: d.anexos.map(attachment),
  });

/**
 * Leitura ao vivo para o app web (cookie) e clientes OAuth (Bearer). Mesmo `ConsultaService` das ferramentas MCP;
 * aqui só traduz para JSON em inglês. Nada é gravado.
 */
@Controller()
@UseFilters(ApiErrorFilter)
@UseGuards(DataGuard)
export class DataController {
  constructor(private readonly consulta: ConsultaService) {}

  @Get('accounts')
  async accounts(@Principal() p: WebPrincipal | null) {
    const contas = await this.consulta.contas(quem(p));
    return {
      accounts: contas.flatMap((c) => {
        const source = SOURCES[c.provider];
        return source
          ? [{ source, account: c.conta, status: c.status === 'OK' ? 'connected' : 'reconnect_required' }]
          : [];
      }),
    };
  }

  @Get('sources/:source/courses')
  async courses(
    @Principal() p: WebPrincipal | null,
    @Param('source') source: string,
    @Query() q?: unknown,
  ) {
    const { account: acc, all } = parseInput(CoursesQuery, q, invalidRequest);
    const list = await this.consulta.listarCursos(quem(p), provider(source), account(acc), { todas: all === 'true' });
    return { courses: list.map(toCourse) };
  }

  @Get('sources/:source/deadlines')
  async deadlines(@Principal() p: WebPrincipal | null, @Param('source') source: string, @Query() q?: unknown) {
    const acc = parseInput(AccountQuery, q, invalidRequest).account;
    const list = await this.consulta.prazos(quem(p), provider(source), account(acc));
    return { deadlines: list.map(toDeadline) };
  }

  @Get('sources/:source/courses/:courseId')
  async course(
    @Principal() p: WebPrincipal | null,
    @Param('source') source: string,
    @Param('courseId') courseId: string,
    @Query() q?: unknown,
  ) {
    const acc = parseInput(AccountQuery, q, invalidRequest).account;
    const list = await this.consulta.verCurso(quem(p), provider(source), account(acc), courseId);
    return { courseId, activities: list.map(toActivity) };
  }

  @Get('sources/:source/forums/:forumId')
  async forum(
    @Principal() p: WebPrincipal | null,
    @Param('source') source: string,
    @Param('forumId') forumId: string,
    @Query() q?: unknown,
  ) {
    const acc = parseInput(AccountQuery, q, invalidRequest).account;
    const list = await this.consulta.verForum(quem(p), provider(source), account(acc), forumId);
    return { forumId, discussions: list.map(toDiscussion) };
  }

  @Get('sources/:source/announcements/:id')
  async announcement(
    @Principal() p: WebPrincipal | null,
    @Param('source') source: string,
    @Param('id') id: string,
    @Query() q?: unknown,
  ) {
    const acc = parseInput(AccountQuery, q, invalidRequest).account;
    return { announcement: toDiscussion(await this.consulta.verAviso(quem(p), provider(source), account(acc), id)) };
  }

  @Get('sources/:source/attachment')
  async attachment(
    @Principal() p: WebPrincipal | null,
    @Param('source') source: string,
    @Query() q: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const { ref, name, account: acc } = parseInput(AttachmentQuery, q, () =>
      new ApiError(400, 'invalid_request', 'Informe o anexo (ref).'),
    );
    const f = await this.consulta.baixar(quem(p), provider(source), account(acc), ref);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(f.fileName ?? name ?? 'anexo'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(Buffer.from(f.bytes));
  }
}
