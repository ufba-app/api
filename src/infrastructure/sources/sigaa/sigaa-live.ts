import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import type {
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  LiveSource,
  PrazoVivo,
} from '../../../application/ports/live-source';
import { SourceError, type Provider, type SourceContext } from '../../../application/ports/source-gateway';
import { htmlToText } from '../moodle/moodle-live';
import { SigaaRateLimitedError } from './http-client';
import { SessoesSigaa } from './sessoes-sigaa';
import {
  SigaaInvalidCredentialsError,
  SigaaLoginUnavailableError,
  SigaaSessionExpiredError,
  type SigaaCredentials,
  type SigaaSession,
} from './session';
import { assertPaginaDaTurmaVirtual } from './turma-virtual/ava-page';
import { parseAvaliacoes, type Avaliacao } from './turma-virtual/avaliacoes';
import { parsePostbackAcessarTurma } from './turma-virtual/entrar-turma';
import { parseNoticiaDetalhe } from './turma-virtual/noticia-detalhe';
import { parseNoticias } from './turma-virtual/noticias';
import { parseTopicos } from './turma-virtual/topicos';
import { parseTurmaVirtualTokens, type TurmaVirtualToken } from './turma-virtual/turma-virtual-tokens';

const PORTAL_PATH = '/sigaa/portais/discente/discente.jsf';
const NOTICIAS_PATH = '/sigaa/ava/NoticiaTurma/listar.jsf';
const NOTICIA_PATH = '/sigaa/ava/NoticiaTurma/mostrar.jsf';
const AVALIACOES_PATH = '/sigaa/ava/DataAvaliacao/listar.jsf';
const TIMELINE_PATH = '/sigaa/ava/Relatorios/timeline.jsf';

/** Teto de turmas que `prazos` visita (2 requisições cada, além do portal). */
export const MAX_TURMAS_PRAZOS = 8;

/** America/Bahia: UTC-3 o ano todo (sem horário de verão). */
const FUSO = '-03:00';
const FUSO_MS = 3 * 60 * 60_000;

const NOTICIA_ID = /^\d+$/;

/** Mensagens fixas: nunca levam senha, JSESSIONID nem corpo de resposta do SIGAA. */
const MSG = {
  semCredencial: 'O SIGAA exige usuário e senha nesta consulta',
  turmaInexistente: 'Turma não encontrada no portal do SIGAA',
  avisoInvalido: 'Aviso do SIGAA inválido: use o `id` de um item `tipo: aviso` de `ver_curso`',
  recusou: 'O SIGAA recusou o usuário e a senha',
  sessao: 'A sessão do SIGAA caiu duas vezes seguidas; tente de novo em instantes',
  limite: 'O SIGAA limitou as requisições; tente de novo em instantes',
  login: 'O SIGAA não concluiu o login agora; tente de novo em instantes',
  pagina: 'O SIGAA devolveu uma página inesperada (fora da turma virtual); tente de novo em instantes',
  indisponivel: 'Não foi possível ler o SIGAA agora; tente de novo em instantes',
  forum: 'SIGAA: ver_forum ainda não tem suporte (use `ver_aviso` para as notícias da turma)',
  baixar: 'SIGAA: baixar anexos ainda não tem suporte',
} as const;

/** Nome da turma → id estável quando o portal não traz `idTurma` (ex.: "VISÃO COMPUTACIONAL" → "visao-computacional"). */
export function slugTurma(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const idDaTurma = (t: TurmaVirtualToken) => t.idTurmaSigaa ?? slugTurma(t.nome);

/** `dd/mm/aaaa` + `HH:MM` (ou meia-noite) no fuso da Bahia. Data que não se lê vira `undefined`. */
export function dataDaBahia(data: string, hora: string | null): Date | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data.trim());
  if (!m) return undefined;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${hora ?? '00:00'}:00${FUSO}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Meia-noite de hoje na Bahia, em UTC. */
function inicioDeHojeNaBahia(agora: number): number {
  const local = agora - FUSO_MS;
  return local - (local % 86_400_000) + FUSO_MS;
}

/** HTML do SIGAA → texto. O SIGAA escreve acentos como entidades numéricas (`&#233;`). */
function texto(html: string | null | undefined): string | undefined {
  return htmlToText(html ?? undefined)
    ?.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function credenciais(ctx: SourceContext): { chave: string; cred: SigaaCredentials } {
  if (ctx.credentials.kind !== 'password' || !ctx.sessaoKey) {
    throw new SourceError('CREDENTIAL_REJECTED', MSG.semCredencial);
  }
  return { chave: ctx.sessaoKey, cred: { login: ctx.credentials.username, password: ctx.credentials.password } };
}

/**
 * Erros do SIGAA → códigos estáveis com mensagem fixa. Senha recusada é `REAUTH_NEEDED` (o `ConsultaService` marca a
 * credencial como inválida); o resto é passageiro. Parser que não reconhece a página também é `UNAVAILABLE`: nunca
 * devolver lista vazia no lugar de "não deu para ler".
 */
function erroDaFonte(e: unknown): SourceError {
  if (e instanceof SourceError) return e;
  if (e instanceof SigaaInvalidCredentialsError) return new SourceError('REAUTH_NEEDED', MSG.recusou);
  if (e instanceof SigaaRateLimitedError) return new SourceError('UNAVAILABLE', MSG.limite);
  if (e instanceof SigaaLoginUnavailableError) return new SourceError('UNAVAILABLE', MSG.login);
  if (e instanceof SigaaSessionExpiredError) return new SourceError('UNAVAILABLE', MSG.sessao);
  if (e instanceof PaginaInesperada) return new SourceError('UNAVAILABLE', MSG.pagina);
  return new SourceError('UNAVAILABLE', MSG.indisponivel);
}

/** Um parser não reconheceu a página (bounce para o portal, casca vazia). Só o tipo importa; a causa não sai daqui. */
class PaginaInesperada extends Error {}

function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new PaginaInesperada();
  }
}

/**
 * Leitura AO VIVO da turma virtual do SIGAA, com os parsers do ufba-app. Cada chamada usa a sessão em memória da
 * pessoa+cliente (`SessoesSigaa`, que faz o login com a senha só desta consulta) e faz só as requisições da
 * pergunta, em sequência (JSF guarda estado de navegação no servidor: nada em paralelo na mesma sessão).
 */
export class SigaaLive implements LiveSource {
  readonly provider: Provider = 'SIGAA';
  private readonly now: () => number;

  constructor(
    private readonly sessoes: SessoesSigaa,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** O portal só mostra as turmas do semestre: `todas` não muda nada. 1 requisição. */
  listarCursos(ctx: SourceContext, _opts?: { todas?: boolean }): Promise<CursoVivo[]> {
    return this.usar(ctx, async (s) => {
      const portal = await s.get(PORTAL_PATH);
      return parse(() => parseTurmaVirtualTokens(portal)).map((t) => ({ id: idDaTurma(t), nome: t.nome }));
    });
  }

  /** Portal, entrada na turma, notícias, avaliações e tópicos: 5 requisições. */
  verCurso(ctx: SourceContext, cursoId: string): Promise<AtividadeViva[]> {
    return this.usar(ctx, async (s) => {
      await this.entrar(s, cursoId);
      const noticiasHtml = await s.get(NOTICIAS_PATH);
      const avaliacoesHtml = await s.get(AVALIACOES_PATH);
      const topicosHtml = await s.get(TIMELINE_PATH);
      const noticias = parse(() => parseNoticias(noticiasHtml));
      const avaliacoes = parse(() => parseAvaliacoes(avaliacoesHtml));
      const topicos = parse(() => parseTopicos(topicosHtml));

      return [
        ...noticias.map(
          (n): AtividadeViva => ({ id: `${cursoId}:${n.id}`, tipo: 'aviso', titulo: n.titulo, anexos: [] }),
        ),
        ...avaliacoes.map((a, i): AtividadeViva => ({
          id: `${cursoId}:avaliacao:${i}`,
          tipo: 'prova',
          titulo: a.descricao,
          ...comPrazo(a),
          anexos: [],
        })),
        ...topicos.map((t, i): AtividadeViva => {
          const descricao = texto(t.conteudoHtml);
          return {
            id: `${cursoId}:topico:${i}`,
            tipo: 'material',
            titulo: t.titulo,
            ...(descricao ? { descricao } : {}),
            anexos: [],
          };
        }),
      ];
    });
  }

  /** `avisoId` = `<turma>:<notícia>` (de `verCurso`). Portal, entrada na turma e a notícia: 3 requisições. */
  verAviso(ctx: SourceContext, avisoId: string): Promise<DiscussaoViva> {
    const i = avisoId.lastIndexOf(':');
    const turma = avisoId.slice(0, i);
    const noticia = avisoId.slice(i + 1);
    if (i <= 0 || !NOTICIA_ID.test(noticia)) {
      return Promise.reject(new SourceError('UNSUPPORTED_SCOPE', MSG.avisoInvalido));
    }
    return this.usar(ctx, async (s) => {
      await this.entrar(s, turma);
      // O `id` precisa ir no corpo do POST: na query, o SIGAA devolve a casca vazia (ver noticia-detalhe.ts).
      const html = await s.postback(NOTICIA_PATH, { id: noticia });
      const n = parse(() => parseNoticiaDetalhe(html));
      const mensagem = texto(n.conteudoHtml);
      return {
        id: avisoId,
        titulo: n.titulo,
        ...(mensagem ? { mensagem } : {}),
        ...(n.autor ? { autor: n.autor } : {}),
        anexos: [],
      };
    });
  }

  /**
   * Avaliações de hoje em diante das primeiras `MAX_TURMAS_PRAZOS` turmas, ordenadas. O SIGAA não tem calendário
   * agregado: portal + (entrada na turma + avaliações) por turma, no máximo 1 + 2×8 requisições.
   */
  prazos(ctx: SourceContext): Promise<PrazoVivo[]> {
    return this.usar(ctx, async (s) => {
      const portal = await s.get(PORTAL_PATH);
      const turmas = parse(() => parseTurmaVirtualTokens(portal)).slice(0, MAX_TURMAS_PRAZOS);
      const desde = inicioDeHojeNaBahia(this.now());
      const prazos: PrazoVivo[] = [];
      for (const t of turmas) {
        await entrarNaTurma(s, portal, t);
        const html = await s.get(AVALIACOES_PATH);
        const cursoId = idDaTurma(t);
        parse(() => parseAvaliacoes(html)).forEach((a, i) => {
          const quando = dataDaBahia(a.data, a.hora);
          if (!quando || quando.getTime() < desde) return;
          prazos.push({
            id: `${cursoId}:avaliacao:${i}`,
            titulo: a.descricao,
            quando,
            cursoId,
            cursoNome: t.nome,
            tipo: 'prova',
          });
        });
      }
      return prazos.sort((a, b) => a.quando.getTime() - b.quando.getTime());
    });
  }

  verForum(_ctx: SourceContext, _forumId: string): Promise<DiscussaoViva[]> {
    return Promise.reject(new SourceError('UNSUPPORTED_SCOPE', MSG.forum));
  }

  baixar(_ctx: SourceContext, _ref: string): Promise<AttachmentContent> {
    return Promise.reject(new SourceError('UNSUPPORTED_SCOPE', MSG.baixar));
  }

  /** Lê o portal, acha a turma (sem ela, nenhum postback) e entra nela. */
  private async entrar(s: SigaaSession, cursoId: string): Promise<void> {
    const portal = await s.get(PORTAL_PATH);
    const turma = parse(() => parseTurmaVirtualTokens(portal)).find((t) => idDaTurma(t) === cursoId);
    if (!turma) throw new SourceError('UNSUPPORTED_SCOPE', MSG.turmaInexistente);
    await entrarNaTurma(s, portal, turma);
  }

  private async usar<T>(ctx: SourceContext, fn: (s: SigaaSession) => Promise<T>): Promise<T> {
    try {
      const { chave, cred } = credenciais(ctx);
      return await this.sessoes.usar(chave, cred, fn);
    } catch (e) {
      throw erroDaFonte(e);
    }
  }
}

/**
 * Postback do form "acessar turma virtual" lido do portal. O SIGAA pode responder 200 com o portal de volta em vez
 * da turma (gotcha 1 do ufba-app): sem o menu da turma, é erro, não "turma vazia".
 */
async function entrarNaTurma(s: SigaaSession, portal: string, turma: TurmaVirtualToken): Promise<void> {
  const { fields } = parse(() => parsePostbackAcessarTurma(portal, turma.frontEndIdTurma));
  const html = await s.postback(PORTAL_PATH, fields);
  parse(() => assertPaginaDaTurmaVirtual(html, 'a página principal da turma'));
}

function comPrazo(a: Avaliacao): { prazo?: Date } {
  const prazo = dataDaBahia(a.data, a.hora);
  return prazo ? { prazo } : {};
}
