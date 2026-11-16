import { Secret } from '../../../application/shared/secret';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { SigaaRateLimitedError } from './http-client';
import type { SecretCipher } from '../../../application/ports/secret-cipher';
import { MemorySigaaSessionStore } from './memory-session-store';
import { SessoesSigaa } from './sessoes-sigaa';
import { SigaaInvalidCredentialsError, SigaaLoginUnavailableError, type SigaaSession } from './session';
import { Logger } from '@nestjs/common';
import { MAX_TURMAS_PRAZOS, SigaaLive, impressaoDaPagina } from './sigaa-live';

const fixture = (nome: string) => readFileSync(join(__dirname, 'turma-virtual', '__fixtures__', nome), 'utf-8');

const PORTAL = '/sigaa/portais/discente/discente.jsf';
const NOTICIAS = '/sigaa/ava/NoticiaTurma/listar.jsf';
const AVALIACOES = '/sigaa/ava/DataAvaliacao/listar.jsf';
const TIMELINE = '/sigaa/ava/Relatorios/timeline.jsf';

const SENHA = 'senha-falsa-de-teste';
const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'sigaa:fulano',
  credentials: { kind: 'password', username: 'fulano', password: Secret.of(SENHA) },
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
  /** Se dado, o portal vem daqui a CADA leitura (tokens e ViewState novos, como o SIGAA real pode fazer). */
  portal?: () => string;
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
    resume: jest.fn(),
    exportCookie: () => Secret.of('JSESSIONID=fake'),
    get: jest.fn(async (path: string) => {
      reqs.push(`GET ${path}`);
      if (path === PORTAL && paginas.portal) return paginas.portal();
      return get[path] ?? '';
    }),
    postback: jest.fn(async (path: string, fields: Record<string, string>) => {
      reqs.push(`POST ${path}`);
      posts.push({ path, fields });
      return postback(path, fields);
    }),
  } as unknown as SigaaSession;
  const cifra = {
    encrypt: (s: string) => ({ ciphertext: s, iv: 'i', authTag: 't' }),
    decrypt: (e: { ciphertext: string }) => e.ciphertext,
  } as unknown as SecretCipher;
  const store = new MemorySigaaSessionStore();
  const live = new SigaaLive(new SessoesSigaa(() => sessao, store, cifra), { now });
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

  describe('agendaSigaa (calendário do Painel): turmas + prazos com UMA leitura do portal', () => {
    it('o portal serve às aulas e à 1ª turma; as demais releem o portal antes de entrar (a sem Turma Virtual entra só nas aulas)', async () => {
      const { live, reqs, posts } = montar();
      const r = await live.agendaSigaa(ctx);
      // Fixture: 3 turmas no portal, 2 com Turma Virtual: portal + (entrar + avaliações) + (portal fresco + entrar + avaliações).
      expect(reqs).toEqual([
        `GET ${PORTAL}`,
        `POST ${PORTAL}`,
        `GET ${AVALIACOES}`,
        `GET ${PORTAL}`,
        `POST ${PORTAL}`,
        `GET ${AVALIACOES}`,
      ]);
      expect(posts).toHaveLength(2);
      expect(r.turmas.map((t) => t.name)).toEqual(['SISTEMAS OPERACIONAIS', 'VISÃO COMPUTACIONAL', 'LABORATÓRIO INTEGRADO III-A']);
      expect(r.prazosCompletos).toBe(true);
      expect(r.prazos.length).toBeGreaterThan(0);
      expect(r.prazos.every((p) => p.tipo === 'prova' && p.quando.getTime() > 0)).toBe(true);
    });

    it(`no máximo 1 + 2 + 3×(${MAX_TURMAS_PRAZOS} − 1) requisições, mesmo com 12 turmas`, async () => {
      const { live, reqs } = montar({ get: { [PORTAL]: portalCom(12) } });
      const r = await live.agendaSigaa(ctx);
      expect(reqs).toHaveLength(1 + 2 + 3 * (MAX_TURMAS_PRAZOS - 1));
      expect(r.prazosCompletos).toBe(true);
    });

    it('falha ao ler os prazos NÃO derruba as aulas: duas turmas seguidas falhando encerram a leitura (sem gastar requisições) e marcam incompleto', async () => {
      let n = 0;
      const { live, reqs } = montar({
        get: { [PORTAL]: portalCom(6) },
        postback: () => {
          if (++n >= 2) throw new Error('SIGAA recusou');
          return PAGINA_DA_TURMA;
        },
      });
      const r = await live.agendaSigaa(ctx);
      expect(r.prazosCompletos).toBe(false);
      expect(r.prazos.length).toBeGreaterThan(0); // o que já veio da 1ª turma fica
      // Portal + (entrar + avaliações da 1ª) + (portal fresco + entrar que falhou) x2: nada mais.
      expect(reqs).toEqual([`GET ${PORTAL}`, `POST ${PORTAL}`, `GET ${AVALIACOES}`, `GET ${PORTAL}`, `POST ${PORTAL}`, `GET ${PORTAL}`, `POST ${PORTAL}`]);
    });

    it('uma turma que falha não impede a seguinte (cada entrada usa o portal fresco)', async () => {
      let n = 0;
      const { live } = montar({
        get: { [PORTAL]: portalCom(3) },
        postback: () => {
          if (++n === 2) throw new Error('turma 2 recusou');
          return PAGINA_DA_TURMA;
        },
      });
      const r = await live.agendaSigaa(ctx);
      expect(r.prazosCompletos).toBe(false);
      expect(new Set(r.prazos.map((p) => p.cursoId))).toEqual(new Set(['turma-0', 'turma-2']));
    });

    it('os tokens mudam a cada renderização do portal: a turma é achada na página FRESCA pelo nome e o postback leva o token novo', async () => {
      let leituras = 0;
      const { live, posts } = montar({ portal: () => portalCom(3).replace(/TOKEN(\d)/g, `R${++leituras}T$1`) });
      const r = await live.agendaSigaa(ctx);
      expect(r.prazosCompletos).toBe(true);
      // 1ª turma: a página do começo (leitura 1). 2ª e 3ª: leituras 2 e 3, com o token novo de cada uma.
      expect(posts.map((p) => p.fields.frontEndIdTurma)).toEqual(['R1T0', 'R2T1', 'R3T2']);
    });

    it('a 1ª entrada volta sem o menu da turma (sessão retomada que o SIGAA não aceita): login novo e uma nova tentativa, como o app antigo', async () => {
      let postbacks = 0;
      const { live, sessao } = montar({
        get: { [PORTAL]: portalCom(2) },
        postback: () => (++postbacks === 1 ? portalCom(2) : PAGINA_DA_TURMA), // 1ª: devolve a home do portal (bounce)
      });
      const r = await live.agendaSigaa(ctx);
      expect(sessao.login).toHaveBeenCalledTimes(2); // o login inicial e o refeito
      expect(r.prazosCompletos).toBe(true);
      expect(r.prazos.length).toBeGreaterThan(0);
    });

    it('se o bounce persiste depois do login novo: não entra em laço (2 logins no máximo), as aulas ficam e o prazos() da ferramenta falha alto', async () => {
      const bounce = () => portalCom(3);
      // Portal da fixture (a tabela de turmas com horário): as aulas vêm da mesma página.
      const a = montar({ postback: bounce });
      const r = await a.live.agendaSigaa(ctx);
      expect(a.sessao.login).toHaveBeenCalledTimes(2);
      expect(r.prazosCompletos).toBe(false);
      expect(r.turmas.length).toBeGreaterThan(0);
      const b = montar({ postback: bounce });
      await expect(b.live.prazos(ctx)).rejects.toBeInstanceOf(SourceError);
      expect(b.sessao.login).toHaveBeenCalledTimes(2);
    });

    it('o bounce deixa no log só a impressão digital da página (tamanho, título, marcas), nunca o corpo, o ViewState nem o token', async () => {
      const avisos: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void avisos.push(String(m)));
      try {
        const { live } = montar({ get: { [PORTAL]: portalCom(2) }, postback: () => '<html><head><title>SIGAA - Portal do Discente</title></head><body>form_acessarTurmaVirtual TOKEN0 javax.faces.ViewState</body></html>' });
        await live.agendaSigaa(ctx);
      } finally {
        spy.mockRestore();
      }
      const msg = avisos.find((m) => m.includes('Entrada na Turma Virtual recusada'))!;
      expect(msg).toContain('"titulo":"SIGAA - Portal do Discente"');
      expect(msg).toContain('"portal":true');
      expect(msg).toContain('"menu":false');
      expect(msg).toMatch(/turma 1\/2/);
      expect(msg).not.toContain('TOKEN0');
      expect(msg).not.toContain('ViewState');
      expect(msg).not.toContain(SENHA);
    });

    it('o prazos() da ferramenta continua falhando alto (sem resultado parcial)', async () => {
      const { live } = montar({
        get: { [PORTAL]: portalCom(3) },
        postback: () => {
          throw new Error('x');
        },
      });
      await expect(live.prazos(ctx)).rejects.toBeInstanceOf(SourceError);
    });

    it('acabou o orçamento de tempo: não entra em outra turma; as aulas ficam e a leitura vem incompleta', async () => {
      const { live, reqs } = montar({ get: { [PORTAL]: portalCom(4) } });
      const r = await live.agendaSigaa(ctx, { orcamentoMs: 0 });
      expect(reqs).toEqual([`GET ${PORTAL}`]); // só o portal
      expect(r.prazosCompletos).toBe(false);
      expect(r.prazos).toEqual([]);
    });

    it('falha ao ler o portal em si continua sendo erro (sem portal não há nada)', async () => {
      const { live } = montar({ login: async () => { throw new SigaaLoginUnavailableError('fora do ar'); } });
      await expect(live.agendaSigaa(ctx)).rejects.toBeInstanceOf(SourceError);
    });

    it('nunca devolve o HTML, o token da Turma Virtual nem a senha', async () => {
      const { live } = montar();
      const out = JSON.stringify(await live.agendaSigaa(ctx));
      expect(out).not.toMatch(/frontEndIdTurma|AAAA1111|jsfcljs|ViewState/);
      expect(out).not.toContain(SENHA);
    });
  });

  it('turmasComHorario: 1 requisição (a mesma página do portal) e inclui a turma sem Turma Virtual', async () => {
    const { live, reqs } = montar();
    const turmas = await live.turmasComHorario(ctx);
    expect(reqs).toEqual([`GET ${PORTAL}`]);
    expect(turmas.map((t) => [t.name, Object.values(t.placeByWeekday)[0], t.blocks[0].shift])).toEqual([
      ['SISTEMAS OPERACIONAIS', 'Sala 12', 'T'],
      ['VISÃO COMPUTACIONAL', 'Sala 8', 'M'],
      ['LABORATÓRIO INTEGRADO III-A', 'Sala 3', 'N'],
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

  it(`prazos: no máximo 1 + 2 + 3×(${MAX_TURMAS_PRAZOS} − 1) requisições com 12 turmas (portal fresco antes de cada turma, menos a 1ª)`, async () => {
    const { live, reqs, posts } = montar({ get: { [PORTAL]: portalCom(12) } });
    const prazos = await live.prazos(ctx);
    expect(MAX_TURMAS_PRAZOS).toBe(8);
    expect(reqs).toHaveLength(1 + 2 + 3 * 7);
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
      live.listarCursos({ ...ctx, credentials: { kind: 'token', token: Secret.of('x') } }),
    ).rejects.toBeInstanceOf(SourceError);
    expect(sessao.login).not.toHaveBeenCalled();
  });

  it('ver_forum e baixar: ainda sem suporte', async () => {
    const { live, reqs } = montar();
    await expect(live.verForum(ctx, 'f')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    await expect(live.baixar(ctx, 'r')).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
    expect(reqs).toEqual([]);
  });
});

describe('impressaoDaPagina', () => {
  it('só tamanho, título curto e marcas; nunca o corpo', () => {
    const html = '<html><head><title>  Página   de erro  </title></head><body><input name="user.login"/>segredo-no-corpo expirada</body></html>';
    expect(JSON.parse(impressaoDaPagina(html))).toEqual({ tamanho: html.length, titulo: 'Página de erro', portal: false, login: true, menu: false, expirada: true });
    expect(impressaoDaPagina(html)).not.toContain('segredo-no-corpo');
    expect(JSON.parse(impressaoDaPagina('sem título')).titulo).toBeNull();
    expect(JSON.parse(impressaoDaPagina(`<title>${'x'.repeat(500)}</title>`)).titulo).toHaveLength(80);
  });
});
