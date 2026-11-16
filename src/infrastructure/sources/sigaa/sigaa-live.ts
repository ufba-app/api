import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import type {
  AgendaSigaa,
  AtividadeViva,
  CursoVivo,
  DiscussaoViva,
  LiveSource,
  ParticipanteVivo,
  PrazoVivo,
} from '../../../application/ports/live-source';
import { SourceError, type Provider, type SourceContext } from '../../../application/ports/source-gateway';
import { htmlToText } from '../moodle/moodle-live';
import { SigaaRateLimitedError } from './http-client';
import type { SigaaSessionKey } from '../../../application/ports/repositories';
import { SessoesSigaa, SigaaOcupadoError } from './sessoes-sigaa';
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
import { parseNoticias, parsePostbackNoticia } from './turma-virtual/noticias';
import { parseDiscentes, parsePostbackParticipantes } from './turma-virtual/participantes';
import { parseTopicos } from './turma-virtual/topicos';
import { parseTurmasHorario } from './turma-virtual/turma-horario';
import { parseTurmaVirtualTokens, type TurmaVirtualToken } from './turma-virtual/turma-virtual-tokens';
import type { ClassSchedule } from '../../../domain/academic/class-schedule';

const PORTAL_PATH = '/sigaa/portais/discente/discente.jsf';
const NOTICIAS_PATH = '/sigaa/ava/NoticiaTurma/listar.jsf';
const AVALIACOES_PATH = '/sigaa/ava/DataAvaliacao/listar.jsf';
const TIMELINE_PATH = '/sigaa/ava/Relatorios/timeline.jsf';

/** Teto de turmas que `prazos` visita: a 1ª custa 2 requisições (entrar + avaliações), as demais 3 (portal fresco + entrar + avaliações). */
export const MAX_TURMAS_PRAZOS = 8;
/** Orçamento de tempo da leitura dos prazos no calendário: depois dele não se entra em outra turma. */
export const ORCAMENTO_PRAZOS_MS = 30_000;

/** America/Bahia: UTC-3 o ano todo (sem horário de verão). */
const FUSO = '-03:00';
const FUSO_MS = 3 * 60 * 60_000;

const NOTICIA_ID = /^\d+$/;

/** Mensagens fixas: nunca levam senha, JSESSIONID nem corpo de resposta do SIGAA. */
const MSG = {
  semCredencial: 'O SIGAA exige usuário e senha nesta consulta',
  turmaInexistente: 'Turma não encontrada no portal do SIGAA',
  avisoInexistente: 'Aviso não encontrado nas notícias da turma do SIGAA: use um `id` atual de `ver_curso`',
  avisoInvalido: 'Aviso do SIGAA inválido: use o `id` de um item `tipo: aviso` de `ver_curso`',
  recusou: 'O SIGAA recusou o usuário e a senha',
  sessao: 'A sessão do SIGAA caiu duas vezes seguidas; tente de novo em instantes',
  ocupado: 'O SIGAA está ocupado com outra consulta desta conta; tente de novo em instantes',
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

// Duas turmas com o mesmo nome no portal (sem `idTurma`) colidem no slug: vale a primeira.
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
/**
 * HTML do SIGAA → texto. O `htmlToText` só resolve `&amp;`/`&lt;`/`&gt;`; o SIGAA manda acentos como entidades
 * nomeadas (`j&aacute;`) ou numéricas (`Not&#237;cias`), resolvidas aqui pelo cheerio, sem reinterpretar `<`.
 * Quebras `\r\n` e linhas só com espaço viram no máximo uma linha em branco.
 */
function texto(html: string | null | undefined): string | undefined {
  const t = htmlToText(html ?? undefined);
  if (t === undefined) return undefined;
  const escapado = t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decodificado = cheerio.load(`<p>${escapado}</p>`, null, false)('p').text();
  const limpo = decodificado
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return limpo || undefined;
}

/** Sessão por pessoa+login (qualquer cliente) e como obter a senha só se for preciso logar. */
function credenciais(ctx: SourceContext): { chave: SigaaSessionKey; obterCred: () => Promise<SigaaCredentials> } {
  const c = ctx.credentials;
  if (c.kind !== 'password' && c.kind !== 'password-on-demand') {
    throw new SourceError('CREDENTIAL_REJECTED', MSG.semCredencial);
  }
  const login = c.username;
  return {
    chave: { userId: ctx.userId, login: login.trim().toLowerCase() },
    obterCred: async () => ({ login, password: c.kind === 'password' ? c.password : await c.open() }),
  };
}

/**
 * Erros do SIGAA → códigos estáveis com mensagem fixa. Senha recusada é `REAUTH_NEEDED` (o `ConsultaService` marca a
 * credencial como inválida); o resto é passageiro. Parser que não reconhece a página também é `UNAVAILABLE`: nunca
 * devolver lista vazia no lugar de "não deu para ler".
 */
export function erroDaFonte(e: unknown): SourceError {
  if (e instanceof SourceError) return e;
  if (e instanceof SigaaInvalidCredentialsError) return new SourceError('REAUTH_NEEDED', MSG.recusou);
  if (e instanceof SigaaRateLimitedError) return new SourceError('UNAVAILABLE', MSG.limite);
  if (e instanceof SigaaLoginUnavailableError) return new SourceError('UNAVAILABLE', MSG.login);
  if (e instanceof SigaaSessionExpiredError) return new SourceError('UNAVAILABLE', MSG.sessao);
  if (e instanceof SigaaOcupadoError) return new SourceError('UNAVAILABLE', MSG.ocupado);
  if (e instanceof PaginaInesperada) return new SourceError('UNAVAILABLE', MSG.pagina);
  return new SourceError('UNAVAILABLE', MSG.indisponivel);
}

/** Um parser não reconheceu a página (bounce para o portal, casca vazia). Só o tipo importa; a causa não sai daqui. */
class PaginaInesperada extends Error {}

const log = new Logger('SigaaLive');

/** A mensagem dos parsers só descreve a página (marcadores ausentes), nunca traz HTML nem segredo: vai para o log. */
function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    log.warn(`Página inesperada do SIGAA: ${e instanceof Error ? e.message : String(e)}`);
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

  /**
   * Turmas do semestre com dia, horário, período e sala, lidas das linhas da tabela do portal: 1 requisição, a mesma
   * página de `listarCursos` (inclui as turmas sem Turma Virtual, que `listarCursos` omite).
   */
  turmasComHorario(ctx: SourceContext): Promise<ClassSchedule[]> {
    return this.usar(ctx, async (s) => {
      const portal = await s.get(PORTAL_PATH);
      return parse(() => parseTurmasHorario(portal));
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

  /**
   * `avisoId` = `<turma>:<notícia>` (de `verCurso`). Portal, entrada na turma, lista de notícias e o clique
   * "Visualizar" da notícia: 4 requisições. POST direto em `mostrar.jsf` com só o `id` volta sem a notícia no SIGAA real.
   */
  verAviso(ctx: SourceContext, avisoId: string): Promise<DiscussaoViva> {
    const i = avisoId.lastIndexOf(':');
    const turma = avisoId.slice(0, i);
    const noticia = avisoId.slice(i + 1);
    if (i <= 0 || !NOTICIA_ID.test(noticia)) {
      return Promise.reject(new SourceError('UNSUPPORTED_SCOPE', MSG.avisoInvalido));
    }
    return this.usar(ctx, async (s) => {
      await this.entrar(s, turma);
      const lista = await s.get(NOTICIAS_PATH);
      if (!parse(() => parseNoticias(lista)).some((n) => n.id === noticia)) {
        throw new SourceError('UNSUPPORTED_SCOPE', MSG.avisoInexistente);
      }
      const clique = parse(() => parsePostbackNoticia(lista, noticia));
      const html = await s.postback(clique.action ?? NOTICIAS_PATH, clique.fields);
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
   *
   * RISCO NÃO VALIDADO no SIGAA real: para caber nesse teto, o portal é lido uma vez só. A partir da 2ª turma, o
   * postback usa os campos do form lido no início, mas o `javax.faces.ViewState` da ÚLTIMA página da sessão (o
   * `SigaaSession.postback` sobrescreve o do form). Se o SIGAA recusar e devolver o portal, `prazos` falha alto
   * (`UNAVAILABLE`, "página inesperada"), nunca com lista parcial ou vazia. Alternativas se falhar: reler o portal
   * antes de cada turma (1 + 3×8) ou mandar o ViewState do próprio form do portal.
   */
  prazos(ctx: SourceContext): Promise<PrazoVivo[]> {
    let tentativa = 0;
    return this.usar(ctx, async (s) => {
      tentativa++;
      const portal = await s.get(PORTAL_PATH);
      const turmas = parse(() => parseTurmaVirtualTokens(portal)).slice(0, MAX_TURMAS_PRAZOS);
      // Falha aqui derruba `prazos` inteiro: nada de resultado parcial.
      return (await this.lerPrazos(s, portal, turmas, { relogin: tentativa === 1 })).prazos;
    });
  }

  /**
   * Calendário do Painel: as turmas com horário E os prazos numa passada, com UMA leitura do portal para as aulas (a de `listarCursos`;
   * serve também à 1ª turma), no máximo 1 + 2 + 3×(`MAX_TURMAS_PRAZOS` − 1) requisições sequenciais (JSF não admite paralelo na sessão). Diferente de `prazos`, aqui a
   * falha na leitura dos prazos NÃO derruba as aulas: a leitura para na primeira falha (não gasta requisições à toa), as turmas
   * seguem valendo e `prazosCompletos` fica `false`. Também para quando acaba o orçamento de tempo (`ORCAMENTO_PRAZOS_MS`).
   * Falha ao ler o portal em si (login, sessão, página inesperada) continua sendo erro: sem portal não há nada.
   */
  agendaSigaa(ctx: SourceContext, opts: { orcamentoMs?: number } = {}): Promise<AgendaSigaa> {
    let tentativa = 0;
    return this.usar(ctx, async (s) => {
      tentativa++;
      const portal = await s.get(PORTAL_PATH);
      const turmas = parse(() => parseTurmasHorario(portal));
      const tokens = parse(() => parseTurmaVirtualTokens(portal)).slice(0, MAX_TURMAS_PRAZOS);
      const limite = this.now() + (opts.orcamentoMs ?? ORCAMENTO_PRAZOS_MS);
      const { prazos, completos } = await this.lerPrazos(s, portal, tokens, { limite, relogin: tentativa === 1 });
      return { turmas, prazos, prazosCompletos: completos };
    });
  }

  /**
   * Entra em cada turma e lê as avaliações. A sequência é a do app antigo (conferida contra o SIGAA real): ANTES de cada entrada, o
   * portal é lido de novo (UM GET fresco, com o ViewState e os tokens novos) e a turma é achada nessa página pelo nome; só a 1ª
   * turma aproveita o portal já lido. Custo: 2 requisições na 1ª turma e 3 nas demais. (Antes o portal era lido uma vez e o ViewState da
   * última página era reaproveitado, o que o SIGAA real recusa: a entrada voltava sem o menu da turma.)
   *
   * Se a 1ª entrada volta sem o menu da turma (sessão retomada que o SIGAA não aceita), e ainda há uma tentativa (`relogin`), lança
   * `SigaaSessionExpiredError`: `SessoesSigaa` faz um login novo e refaz a leitura, como o app antigo, que sempre logava.
   *
   * Sem `limite`, qualquer falha propaga; com `limite` (ms desde a época), a falha de uma turma não encerra (tenta a próxima com
   * portal fresco; duas seguidas encerram) e o estouro do tempo encerra, devolvendo o que já veio com `completos: false`.
   */
  private async lerPrazos(
    s: SigaaSession,
    portal: string,
    turmas: TurmaVirtualToken[],
    opts: { limite?: number; relogin?: boolean } = {},
  ): Promise<{ prazos: PrazoVivo[]; completos: boolean }> {
    const { limite } = opts;
    const desde = inicioDeHojeNaBahia(this.now());
    const prazos: PrazoVivo[] = [];
    let completos = true;
    let lidas = 0;
    let falhasSeguidas = 0;
    for (const [n, t] of turmas.entries()) {
      if (limite !== undefined && this.now() >= limite) {
        completos = false;
        break;
      }
      try {
        const pagina = n === 0 ? portal : await s.get(PORTAL_PATH);
        // Os tokens podem mudar a cada renderização do portal: acha a turma na página fresca (mesmo token, senão o mesmo nome).
        const doPortal = parse(() => parseTurmaVirtualTokens(pagina));
        const mesmoNome = doPortal.filter((x) => x.nome === t.nome);
        const ordem = turmas.slice(0, n).filter((x) => x.nome === t.nome).length;
        const atual = doPortal.find((x) => x.frontEndIdTurma === t.frontEndIdTurma) ?? mesmoNome[ordem] ?? mesmoNome[0] ?? t;
        await entrarNaTurma(s, pagina, atual, `${n + 1}/${turmas.length}`);
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
        lidas++;
        falhasSeguidas = 0;
      } catch (e) {
        if (e instanceof PaginaInesperada && lidas === 0 && opts.relogin) throw new SigaaSessionExpiredError();
        if (limite === undefined) throw e;
        completos = false;
        if (++falhasSeguidas >= 2) break;
      }
    }
    return { prazos: prazos.sort((a, b) => a.quando.getTime() - b.quando.getTime()), completos };
  }

  /**
   * Alunos (discentes) da turma: só o nome. 3 requisições: portal, entrar na turma e o postback do link "Participantes"
   * do menu. Docentes ficam de fora; matrícula e e-mail nunca saem daqui.
   */
  listarParticipantes(ctx: SourceContext, cursoId: string): Promise<ParticipanteVivo[]> {
    return this.usar(ctx, async (s) => {
      const portal = await s.get(PORTAL_PATH);
      const turma = parse(() => parseTurmaVirtualTokens(portal)).find((t) => idDaTurma(t) === cursoId);
      if (!turma) throw new SourceError('UNSUPPORTED_SCOPE', MSG.turmaInexistente);
      const { fields } = parse(() => parsePostbackAcessarTurma(portal, turma.frontEndIdTurma));
      const turmaHtml = await s.postback(PORTAL_PATH, fields);
      const menu = parse(() => parsePostbackParticipantes(turmaHtml));
      const html = await s.postback(menu.action ?? PORTAL_PATH, menu.fields);
      const nomes = parse(() => parseDiscentes(html));
      return nomes.map((nome) => ({ nome, papeis: ['student'] }));
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
      const { chave, obterCred } = credenciais(ctx);
      return await this.sessoes.usar(chave, obterCred, fn);
    } catch (e) {
      throw erroDaFonte(e);
    }
  }
}

/**
 * Postback do form "acessar turma virtual" lido do portal. O SIGAA pode responder 200 com o portal de volta em vez
 * da turma (gotcha 1 do ufba-app): sem o menu da turma, é erro, não "turma vazia".
 */
/**
 * Impressão digital de uma página que NÃO é a da turma virtual, para diagnosticar o "bounce" pelo log sem expor conteúdo: tamanho, título
 * (curto) e marcas da página (portal, login, menu da turma, sessão expirada). Nunca o corpo, o ViewState nem o token.
 */
export function impressaoDaPagina(html: string): string {
  const titulo = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null;
  return JSON.stringify({
    tamanho: html.length,
    titulo,
    portal: html.includes('form_acessarTurmaVirtual'),
    login: html.includes('user.login'),
    menu: html.includes('formMenu'),
    expirada: html.toLowerCase().includes('expirada'),
  });
}

async function entrarNaTurma(s: SigaaSession, portal: string, turma: TurmaVirtualToken, rotulo = ''): Promise<void> {
  const { fields } = parse(() => parsePostbackAcessarTurma(portal, turma.frontEndIdTurma));
  const html = await s.postback(PORTAL_PATH, fields);
  try {
    parse(() => assertPaginaDaTurmaVirtual(html, 'a página principal da turma'));
  } catch (e) {
    log.warn(`Entrada na Turma Virtual recusada${rotulo ? ` (turma ${rotulo})` : ''}; página recebida: ${impressaoDaPagina(html)}`);
    throw e;
  }
}

function comPrazo(a: Avaliacao): { prazo?: Date } {
  const prazo = dataDaBahia(a.data, a.hora);
  return prazo ? { prazo } : {};
}
