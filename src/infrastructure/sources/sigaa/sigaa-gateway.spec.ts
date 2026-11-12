import { Secret } from '../../../application/shared/secret';
import type {
  SigaaHttpClient,
  SigaaHttpRequest,
  SigaaHttpResponse,
} from './http-client';
import { parseHistoryMenuPostback, parseStudentProfile } from './parsers';
import { SigaaGateway } from './sigaa-gateway';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';

const PASSWORD = 'senha-sintetica-123';

const LOGIN_PAGE = `<html><form name="loginForm" action="/sigaa/logar.do?dispatch=logOn">
<input type="hidden" name="token" value="t0k"/><input type="text" name="user.login"/>
<input type="password" name="user.senha"/></form></html>`;

const PORTAL = `<html><body>
<table id="agenda-docente"><tr><td>Matrícula:</td><td>000000001</td></tr>
<tr><td>Curso:</td><td>CURSO FICTICIO</td></tr>
<tr><td>Período de Ingresso:</td><td>2024.1</td></tr></table>
<form id="menu:form_menu_discente"><input type="hidden" name="id" value="4242"/>
<input type="hidden" name="javax.faces.ViewState" value="vs1"/></form>
<script>cmDrawFromText('x',['menu_form_menu_discente_j_id_jsp_1_4_menu:A]#{ portalDiscente.historicoComDadosAdicionais }'],'menu_form_menu_discente_j_id_jsp_1_5_menu:A]#{ portalDiscente.historico }')</script>
</body></html>`;

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe, 0x00])]);

function res(p: Partial<SigaaHttpResponse>): SigaaHttpResponse {
  const body = p.body ?? '';
  return {
    status: 200,
    headers: {},
    body,
    bodyBuffer: Buffer.from(body, 'latin1'),
    ...p,
  };
}

function fakeSigaa(opts: { loginOk?: boolean; loginBody?: string; pdf?: Buffer; expireAfterLogin?: boolean } = {}) {
  const requests: SigaaHttpRequest[] = [];
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push(req);
      if (req.path === '/') return res({ status: 302, headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } });
      if (req.path === '/sigaa/verTelaLogin.do') return res({ body: LOGIN_PAGE });
      if (req.path.startsWith('/sigaa/logar.do')) {
        return opts.loginOk === false
          ? res({ body: opts.loginBody ?? LOGIN_PAGE })
          : res({ status: 302, headers: { location: '/sigaa/paginaInicial.do' } });
      }
      if (req.path === '/sigaa/paginaInicial.do') return res({ body: '<html>ok</html>' });
      if (req.path === '/sigaa/portais/discente/discente.jsf') {
        if (opts.expireAfterLogin) return res({ body: LOGIN_PAGE });
        if (req.method === 'GET') return res({ body: PORTAL });
        return res({ bodyBuffer: opts.pdf ?? PDF, body: '' });
      }
      return res({ status: 404 });
    },
  };
  return { http, requests };
}

describe('parsers', () => {
  it('perfil do aluno; campos ausentes viram nulo', () => {
    expect(parseStudentProfile(PORTAL)).toEqual({
      registration: '000000001',
      program: 'CURSO FICTICIO',
      entryTerm: '2024.1',
    });
    expect(parseStudentProfile('<html></html>')).toEqual({
      registration: null,
      program: null,
      entryTerm: null,
    });
  });

  it('menu do histórico não confunde com histórico completo', () => {
    expect(parseHistoryMenuPostback(PORTAL)).toEqual({
      id: '4242',
      jscookAction: 'menu_form_menu_discente_j_id_jsp_1_5_menu:A]#{ portalDiscente.historico }',
    });
    expect(() => parseHistoryMenuPostback('<html></html>')).toThrow();
  });
});


const ctx = (password = Secret.of(PASSWORD)): SourceContext => ({
  userId: 'u1',
  accountKey: 'sigaa',
  credentials: { kind: 'password', username: 'u', password },
});
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof SourceError ? e.code : String(e)),
  );

describe('SigaaGateway (SourceGateway)', () => {
  it('declara provider SIGAA e segredo por requisição', () => {
    const g = new SigaaGateway(fakeSigaa().http);
    expect(g.provider).toBe('SIGAA');
    expect(g.auth).toBe('segredo-por-requisicao');
  });

  it('fetch: só perfil; sem items/courseSpaces/events (a fonte não os tem)', async () => {
    const { http, requests } = fakeSigaa();
    const out = await new SigaaGateway(http).fetch(ctx(), { kind: 'tudo' });
    expect(out).toEqual({
      profile: { registration: '000000001', programName: 'CURSO FICTICIO', entryTerm: '2024.1' },
    });
    expect(out.items).toBeUndefined();
    expect(requests.some((r) => r.method === 'POST' && r.path.includes('discente.jsf'))).toBe(false);
    const login = requests.find((r) => r.path.startsWith('/sigaa/logar.do'));
    expect(login?.body).toMatchObject({ 'user.login': 'u', 'user.senha': PASSWORD, token: 't0k' });
  });

  it('fetchSnapshot baixa o PDF do histórico', async () => {
    const { http, requests } = fakeSigaa();
    const snap = await new SigaaGateway(http).fetchSnapshot(ctx(), { transcript: true });
    expect(snap.transcriptPdf?.equals(PDF)).toBe(true);
    expect(requests.at(-1)?.body).toMatchObject({ id: '4242', 'javax.faces.ViewState': 'vs1' });
  });

  it('alcance diferente de tudo e credencial que não é senha', async () => {
    const g = new SigaaGateway(fakeSigaa().http);
    expect(await codeOf(g.fetch(ctx(), { kind: 'curso', courseExternalId: 'x' }))).toBe('UNSUPPORTED_SCOPE');
    expect(
      await codeOf(g.fetch({ ...ctx(), credentials: { kind: 'token', token: 't' } }, { kind: 'tudo' })),
    ).toBe('CREDENTIAL_REJECTED');
  });

  it('mapeia erros: senha errada, login mudo, sessão expirada', async () => {
    const wrong = fakeSigaa({ loginOk: false, loginBody: '<html>Usuário e/ou senha inválidos</html>' });
    expect(await codeOf(new SigaaGateway(wrong.http).fetch(ctx(), { kind: 'tudo' }))).toBe('CREDENTIAL_REJECTED');
    const mute = fakeSigaa({ loginOk: false });
    expect(await codeOf(new SigaaGateway(mute.http).fetch(ctx(), { kind: 'tudo' }))).toBe('BLOCKED');
    const expired = fakeSigaa({ expireAfterLogin: true });
    expect(await codeOf(new SigaaGateway(expired.http).fetch(ctx(), { kind: 'tudo' }))).toBe('REAUTH_NEEDED');
    // sem senha guardada: nenhum segundo login
    expect(expired.requests.filter((q) => q.path.startsWith('/sigaa/logar.do'))).toHaveLength(1);
  });

  it('recusa HTML no lugar do PDF', async () => {
    const { http } = fakeSigaa({ pdf: Buffer.from('<html>erro</html>') });
    expect(await codeOf(new SigaaGateway(http).fetchSnapshot(ctx(), { transcript: true }))).toBe('UNAVAILABLE');
  });

  it('nunca expõe a senha em erros nem no resultado', async () => {
    const wrong = fakeSigaa({ loginOk: false });
    const err = await new SigaaGateway(wrong.http).fetch(ctx(), { kind: 'tudo' }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(PASSWORD);
    const out = await new SigaaGateway(fakeSigaa().http).fetchSnapshot(ctx(), { transcript: true });
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
  });
});
