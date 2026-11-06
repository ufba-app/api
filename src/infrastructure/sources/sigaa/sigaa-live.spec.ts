import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { SigaaRateLimitedError } from './http-client';
import { SessoesSigaa } from './sessoes-sigaa';
import { SigaaInvalidCredentialsError, type SigaaSession } from './session';
import { MAX_TURMAS_PRAZOS, SigaaLive } from './sigaa-live';

const fixture = (nome: string) => readFileSync(join(__dirname, 'turma-virtual', '__fixtures__', nome), 'utf-8');

const PORTAL = '/sigaa/portais/discente/discente.jsf';
const NOTICIAS = '/sigaa/ava/NoticiaTurma/listar.jsf';
const AVALIACOES = '/sigaa/ava/DataAvaliacao/listar.jsf';
const TIMELINE = '/sigaa/ava/Relatorios/timeline.jsf';

const SENHA = 'senha-falsa-de-teste';
const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'sigaa:fulano',
  sessaoKey: 'u1:cliente1:fulano',
  credentials: { kind: 'password', username: 'fulano', password: SENHA },
};

/** Página principal da turma: só precisa do menu da turma (`form#formMenu`). */
const PAGINA_DA_TURMA = '<form id="formMenu" action="/sigaa/ava/index.jsf"></form><h2>Turma</h2>';

/** Portal com `n` turmas (forms iguais ao real, tokens falsos). */
function portalCom(n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const sufixo = i === 0 ? '' : `j_id_${i}`;
    const form = `form_acessarTurmaVirtual${sufixo}`;
    return `<form id="${form}" name="${form}" method="post" action="${PORTAL}">
<input type="hidden" name="${form}" value="${form}" />
<a href="#" onclick="jsfcljs(document.getElementById('${form}'),{'${form}:j_id_jsp_1':'${form}:j_id_jsp_1','frontEndIdTurma':'TOKEN${i}'},'');">TURMA ${i}</a>
<input type="hidden" name="javax.faces.ViewState" value="j_id2" />
</form>`;
  }).join('\n');
}

interface Pagina {
  get?: Record<string, string>;
  postback?: (path: string, fields: Record<string, string>) => string;
  login?: () => Promise<void>;
}

/** Sessão falsa servindo as fixtures; registra cada requisição (o login não conta). */
function montar(paginas: Pagina = {}, now = () => Date.parse('2026-11-04T12:00:00Z')) {
  const reqs: string[] = [];
  const posts: { path: string; fields: Record<string, string> }[] = [];
  const get: Record<string, string> = {
    [PORTAL]: fixture('portal-discente-turma-virtual.html'),
    [NOTICIAS]: fixture('noticias-listar.html'),
    [AVALIACOES]: fixture('avaliacoes-listar.html'),
    [TIMELINE]: fixture('timeline.html'),
    ...paginas.get,
  };
  const postback =
    paginas.postback ?? ((path: string) => (path === NOTICIAS ? fixture('noticia-mostrar.html') : PAGINA_DA_TURMA));
  const sessao = {
    login: jest.fn(paginas.login ?? (async () => undefined)),
    get: jest.fn(async (path: string) => {
      reqs.push(`GET ${path}`);
      return get[path] ?? '';
    }),
    postback: jest.fn(async (path: string, fields: Record<string, string>) => {
      reqs.push(`POST ${path}`);
      posts.push({ path, fields });
      return postback(path, fields);
    }),
  } as unknown as SigaaSession;
  const live = new SigaaLive(new SessoesSigaa(() => sessao), { now });
  return { live, reqs, posts, sessao };
}

describe('SigaaLive', () => {
  it('listar_cursos: 1 requisição', async () => {
    const { live, reqs } = montar();
    const cursos = await live.listarCursos(ctx, { todas: true });
    expect(reqs).toEqual([`GET ${PORTAL}`]);
    expect(cursos).toEqual([
      { id: 'sistemas-operacionais', nome: 'SISTEMAS OPERACIONAIS' },
      { id: 'visao-computacional', nome: 'VISÃO COMPUTACIONAL' },
    ]);
  });

  it('ver_curso: 5 requisições, na ordem portal, postback, notícias, avaliações, timeline', async () => {
    const { live, reqs, posts } = montar();
    const atividades = await live.verCurso(ctx, 'visao-computacional');
    expect(reqs).toEqual([`GET ${PORTAL}`, `POST ${PORTAL}`, `GET ${NOTICIAS}`, `GET ${AVALIACOES}`, `GET ${TIMELINE}`]);
    expect(posts[0].fields.frontEndIdTurma).toBe('FFFF6666GGGG7777HHHH8888IIII9999JJJJ0000');
    expect(atividades.filter((a) => a.tipo === 'aviso')).toEqual([
      { id: 'visao-computacional:6279402', tipo: 'aviso', titulo: 'Início do Semestre', anexos: [] },
    ]);
    expect(atividades.filter((a) => a.tipo === 'material')).toMatchObject([
      { tipo: 'material', titulo: 'Aula 1', anexos: [] },
      { tipo: 'material', titulo: 'Aula 2', descricao: 'Slides da aula 2 anexados.', anexos: [] },
    ]);
  });

  it('ver_curso mapeia avaliação com prazo em UTC-3', async () => {
    const { live } = montar();
    const provas = (await live.verCurso(ctx, 'sistemas-operacionais')).filter((a) => a.tipo === 'prova');
    expect(provas).toMatchObject([
      { tipo: 'prova', titulo: 'Prova 1', anexos: [] },
      { tipo: 'prova', titulo: 'Prova 2', anexos: [] },
    ]);
    expect(provas[0].prazo?.toISOString()).toBe('2026-10-06T19:40:00.000Z');
    expect(provas[1].prazo?.toISOString()).toBe('2026-11-17T11:00:00.000Z');
  });

  it('ver_aviso: 4 requisições (lista + clique da notícia) e mensagem em texto', async () => {
    const { live, reqs, posts } = montar();
    const aviso = await live.verAviso(ctx, 'sistemas-operacionais:6279402');
    expect(reqs).toEqual([`GET ${PORTAL}`, `POST ${PORTAL}`, `GET ${NOTICIAS}`, `POST ${NOTICIAS}`]);
    expect(posts[1].fields).toEqual({
      formListagem: 'formListagem',
      'formListagem:j_id_301': 'formListagem:j_id_301',
      id: '6279402',
    });
    expect(aviso).toEqual({
      id: 'sistemas-operacionais:6279402',
      titulo: 'Início do Semestre',
      mensagem: 'Boa tarde, turma. Sejam bem-vindos.',
      autor: 'NOME DO DOCENTE',
      anexos: [],
    });
  });

  it('ver_aviso com id malformado: erro sem requisição', async () => {
    const { live, reqs } = montar();
    await expect(live.verAviso(ctx, 'sem-separador')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    await expect(live.verAviso(ctx, 'turma:abc')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    expect(reqs).toEqual([]);
  });

  it(`prazos: no máximo 1 + 2×${MAX_TURMAS_PRAZOS} requisições com 12 turmas`, async () => {
    const { live, reqs, posts } = montar({ get: { [PORTAL]: portalCom(12) } });
    const prazos = await live.prazos(ctx);
    expect(MAX_TURMAS_PRAZOS).toBe(8);
    expect(reqs).toHaveLength(1 + 2 * 8);
    expect(reqs[0]).toBe(`GET ${PORTAL}`);
    expect(posts.map((p) => p.fields.frontEndIdTurma)).toEqual(Array.from({ length: 8 }, (_, i) => `TOKEN${i}`));
    // Prova 1 (06/10) já passou; Prova 2 (17/11) fica, uma por turma.
    expect(prazos).toHaveLength(8);
    expect(prazos[0]).toMatchObject({ titulo: 'Prova 2', cursoId: 'turma-0', cursoNome: 'TURMA 0', tipo: 'prova' });
    expect(prazos[0].quando.toISOString()).toBe('2026-11-17T11:00:00.000Z');
  });

  it('prazos: só de hoje em diante (fuso da Bahia), ordenados', async () => {
    const avaliacoes = `<form id="formMenu" action="/sigaa/ava/index.jsf"></form><table class="listing">
      <tr><td>20/11/2026</td><td>10h00</td><td>Seminário</td><td></td></tr>
      <tr><td>04/11/2026</td><td>08h00</td><td>Hoje cedo</td><td></td></tr>
      <tr><td>03/11/2026</td><td>23h59</td><td>Ontem</td><td></td></tr>
      <tr><td>10/11/2026</td><td></td><td>Sem hora</td><td></td></tr>
    </table>`;
    // Meio-dia de 04/11 em Salvador. "Hoje cedo" já passou, mas é de hoje: fica. "Ontem 23h59" é 02:59Z do dia 4
    // (mesmo dia em UTC), mas já é ontem na Bahia: sai.
    const { live } = montar({ get: { [PORTAL]: portalCom(1), [AVALIACOES]: avaliacoes } }, () =>
      Date.parse('2026-11-04T15:00:00Z'),
    );
    const prazos = await live.prazos(ctx);
    expect(prazos.map((p) => p.titulo)).toEqual(['Hoje cedo', 'Sem hora', 'Seminário']);
  });

  it('turma inexistente: erro sem postback', async () => {
    const { live, reqs } = montar();
    const erro = await live.verCurso(ctx, 'calculo-a').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SourceError);
    expect(erro).toMatchObject({ code: 'UNSUPPORTED_SCOPE', message: 'Turma não encontrada no portal do SIGAA' });
    expect(reqs).toEqual([`GET ${PORTAL}`]);
  });

  it('postback que volta para o portal (casca vazia): erro, não lista vazia', async () => {
    const portal = fixture('portal-discente-turma-virtual.html');
    const { live, reqs } = montar({ postback: () => portal });
    const erro = await live.verCurso(ctx, 'sistemas-operacionais').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(SourceError);
    expect(erro).toMatchObject({ code: 'UNAVAILABLE' });
    expect(reqs).toEqual([`GET ${PORTAL}`, `POST ${PORTAL}`]);
  });

  it('ver_aviso: entidades nomeadas viram acentos e as quebras de linha ficam limpas', async () => {
    const html = fixture('noticia-mostrar.html').replace(
      '<p>Boa tarde, turma. <strong>Sejam bem-vindos</strong>.</p>',
      'As aulas j&aacute; come&ccedil;am na ter&ccedil;a.\n\r\n \n\r\nAtenciosamente, Cl&aacute;udio &amp; equipe &lt;DCC&gt;',
    );
    const { live } = montar({ postback: (path) => (path === NOTICIAS ? html : PAGINA_DA_TURMA) });
    const aviso = await live.verAviso(ctx, 'sistemas-operacionais:6279402');
    expect(aviso.mensagem).toBe('As aulas já começam na terça.\n\nAtenciosamente, Cláudio & equipe <DCC>');
  });

  it('notícia que não está na lista da turma: erro claro, sem o clique', async () => {
    const { live, reqs } = montar();
    await expect(live.verAviso(ctx, 'sistemas-operacionais:999')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    expect(reqs).toEqual([`GET ${PORTAL}`, `POST ${PORTAL}`, `GET ${NOTICIAS}`]);
  });

  it('notícia que volta como casca vazia: erro', async () => {
    const casca = fixture('noticia-mostrar-casca-vazia.html');
    const { live } = montar({ postback: (path) => (path === NOTICIAS ? casca : PAGINA_DA_TURMA) });
    await expect(live.verAviso(ctx, 'sistemas-operacionais:6279402')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('senha recusada pelo SIGAA: REAUTH_NEEDED, sem a senha na mensagem', async () => {
    const { live, reqs } = montar({
      login: async () => {
        throw new SigaaInvalidCredentialsError();
      },
    });
    const erro = (await live.listarCursos(ctx).catch((e: unknown) => e)) as SourceError;
    expect(erro).toBeInstanceOf(SourceError);
    expect(erro.code).toBe('REAUTH_NEEDED');
    expect(erro.message).not.toContain(SENHA);
    expect(reqs).toEqual([]);
  });

  it('limite de requisições do SIGAA: UNAVAILABLE', async () => {
    const { live, sessao } = montar();
    (sessao.get as jest.Mock).mockRejectedValueOnce(new SigaaRateLimitedError());
    await expect(live.listarCursos(ctx)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('erro inesperado vira mensagem fixa (nada do corpo da resposta)', async () => {
    const { live, sessao } = montar();
    (sessao.get as jest.Mock).mockRejectedValueOnce(new Error('<html>corpo com JSESSIONID=abc</html>'));
    const erro = (await live.listarCursos(ctx).catch((e: unknown) => e)) as SourceError;
    expect(erro).toMatchObject({ code: 'UNAVAILABLE' });
    expect(erro.message).not.toContain('JSESSIONID');
  });

  it('sem usuário e senha ou sem chave de sessão: erro sem tocar o SIGAA', async () => {
    const { live, sessao } = montar();
    await expect(
      live.listarCursos({ ...ctx, credentials: { kind: 'token', token: 'x' } }),
    ).rejects.toBeInstanceOf(SourceError);
    await expect(live.listarCursos({ ...ctx, sessaoKey: undefined })).rejects.toBeInstanceOf(SourceError);
    expect(sessao.login).not.toHaveBeenCalled();
  });

  it('ver_forum e baixar: ainda sem suporte', async () => {
    const { live, reqs } = montar();
    await expect(live.verForum(ctx, 'f')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    await expect(live.baixar(ctx, 'r')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    expect(reqs).toEqual([]);
  });
});
