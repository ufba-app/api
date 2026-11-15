import type { SecretCipher } from '../../../../application/ports/secret-cipher';
import { SourceError } from '../../../../application/ports/source-gateway';
import { Secret } from '../../../../application/shared/secret';
import type { SigaaHttpClient, SigaaHttpResponse } from '../http-client';
import { MemorySigaaSessionStore } from '../memory-session-store';
import { SessoesSigaa } from '../sessoes-sigaa';
import { SigaaSession } from '../session';
import { PORTAL_HOME_PATH } from './transcript-download';
import { SessionTranscriptSource } from './session-transcript-source';

const SENHA = 'senha-sintetica-123';

const LOGIN_PAGE = `<html><form name="loginForm" action="/sigaa/logar.do?dispatch=logOn">
<input type="hidden" name="token" value="t0k"/><input type="text" name="user.login"/>
<input type="password" name="user.senha"/></form></html>`;

const PORTAL = `<html><body>
<table id="agenda-docente"><tr><td>Matrícula:</td><td>000000001</td></tr>
<tr><td>Curso:</td><td>CURSO FICTICIO</td></tr>
<tr><td>Período de Ingresso:</td><td>2024.1</td></tr></table>
<form id="menu:form_menu_discente"><input type="hidden" name="id" value="4242"/>
<input type="hidden" name="javax.faces.ViewState" value="vs1"/></form>
<script>cmDrawFromText('x',['menu_form_menu_discente_j_id_jsp_1_5_menu:A]#{ portalDiscente.historico }'])</script>
</body></html>`;

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe, 0x00])]);

const res = (p: Partial<SigaaHttpResponse>): SigaaHttpResponse => {
  const body = p.body ?? '';
  return { status: 200, headers: {}, body, bodyBuffer: Buffer.from(body, 'latin1'), ...p };
};

function fakeSigaa(opts: { loginOk?: boolean; pdf?: Buffer; expireRedirect?: boolean } = {}) {
  const requests: { method: string; path: string }[] = [];
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push({ method: req.method, path: req.path });
      if (req.path === '/') return res({ status: 302, headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } });
      if (req.path === '/sigaa/verTelaLogin.do') return res({ body: LOGIN_PAGE });
      if (req.path.startsWith('/sigaa/logar.do')) {
        return opts.loginOk === false
          ? res({ body: '<html>Usuário e/ou senha inválidos</html>' })
          : res({ status: 302, headers: { location: '/sigaa/paginaInicial.do' } });
      }
      if (req.path === '/sigaa/paginaInicial.do') return res({ body: '<html>ok</html>' });
      if (req.path === PORTAL_HOME_PATH) {
        if (opts.expireRedirect) return res({ status: 302, headers: { location: 'https://sigaa.ufba.br/sigaa/expirada.jsp' } });
        if (req.method === 'GET') return res({ body: PORTAL });
        return res({ bodyBuffer: opts.pdf ?? PDF, body: '' });
      }
      return res({ status: 404 });
    },
  };
  return { http, requests };
}

const cifra = {
  encrypt: (s: string) => ({ ciphertext: s, iv: 'i', authTag: 't' }),
  decrypt: (e: { ciphertext: string }) => e.ciphertext,
} as unknown as SecretCipher;

function montar(opts: Parameters<typeof fakeSigaa>[0] = {}) {
  const { http, requests } = fakeSigaa(opts);
  const store = new MemorySigaaSessionStore();
  const source = new SessionTranscriptSource(new SessoesSigaa(() => new SigaaSession(http), store, cifra));
  return { source, requests };
}

const entrada = { userId: 'u1', login: '12345678901', password: Secret.of(SENHA) };

describe('SessionTranscriptSource (PDF do histórico pela sessão da pessoa)', () => {
  it('loga, lê o perfil no portal e baixa o PDF pelo menu "Emitir Histórico"', async () => {
    const { source, requests } = montar();
    const snap = await source.fetch(entrada);
    expect(snap.pdf.equals(PDF)).toBe(true);
    expect(snap.profile).toEqual({ registration: '000000001', program: 'CURSO FICTICIO', entryTerm: '2024.1' });
    expect(requests.filter((r) => r.path === PORTAL_HOME_PATH).map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  it('a segunda importação reaproveita a sessão guardada (sem novo login)', async () => {
    const { source, requests } = montar();
    await source.fetch(entrada);
    const logins = () => requests.filter((r) => r.path.startsWith('/sigaa/logar.do')).length;
    expect(logins()).toBe(1);
    await source.fetch(entrada);
    expect(logins()).toBe(1);
  });

  it('senha recusada: REAUTH_NEEDED, sem a senha na mensagem', async () => {
    const { source } = montar({ loginOk: false });
    const erro = (await source.fetch(entrada).catch((e: unknown) => e)) as SourceError;
    expect(erro).toBeInstanceOf(SourceError);
    expect(erro.code).toBe('REAUTH_NEEDED');
    expect(`${erro.message} ${JSON.stringify(erro)}`).not.toContain(SENHA);
  });

  it('o SIGAA devolve HTML no lugar do PDF: indisponível, nunca um documento falso', async () => {
    const { source } = montar({ pdf: Buffer.from('<html>sessão perdida</html>') });
    const erro = (await source.fetch(entrada).catch((e: unknown) => e)) as SourceError;
    expect(erro).toBeInstanceOf(SourceError);
    expect(erro.code).toBe('UNAVAILABLE');
    expect(erro.message).not.toContain(SENHA);
  });

  it('sessão expirada duas vezes seguidas: erro (a importação vira SESSION_EXPIRED/SIGAA_UNAVAILABLE)', async () => {
    const { source } = montar({ expireRedirect: true });
    await expect(source.fetch(entrada)).rejects.toBeInstanceOf(SourceError);
  });
});
