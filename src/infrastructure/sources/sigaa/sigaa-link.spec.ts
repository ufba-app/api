import type { CofreSigaa } from '../../../application/sigaa/cofre-sigaa';
import type { SigaaHttpClient, SigaaHttpRequest, SigaaHttpResponse } from './http-client';
import { SigaaLink } from './sigaa-link';

const SENHA = 'senha-sintetica-123';

const LOGIN_PAGE = `<html><form name="loginForm" action="/sigaa/logar.do?dispatch=logOn">
<input type="hidden" name="token" value="t0k"/><input type="text" name="user.login"/>
<input type="password" name="user.senha"/></form></html>`;

function res(p: Partial<SigaaHttpResponse>): SigaaHttpResponse {
  const body = p.body ?? '';
  return { status: 200, headers: {}, body, bodyBuffer: Buffer.from(body, 'latin1'), ...p };
}

function fakeSigaa(loginOk: boolean) {
  const requests: SigaaHttpRequest[] = [];
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push(req);
      if (req.path === '/') return res({ status: 302, headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } });
      if (req.path === '/sigaa/verTelaLogin.do') return res({ body: LOGIN_PAGE });
      if (req.path.startsWith('/sigaa/logar.do')) {
        return loginOk
          ? res({ status: 302, headers: { location: '/sigaa/paginaInicial.do' } })
          : res({ body: `${LOGIN_PAGE} Usuário e/ou senha inválidos` });
      }
      if (req.path === '/sigaa/paginaInicial.do') return res({ body: '<html>ok</html>' });
      if (req.path === '/sigaa/portais/discente/discente.jsf') return res({ body: '<html>portal</html>' });
      return res({ status: 404 });
    },
  };
  return { http, requests };
}

function fakeCofre() {
  const aguardar = jest.fn();
  return { cofre: { aguardar, temPendente: (t: string) => t === 'txn-1' } as unknown as CofreSigaa, aguardar };
}

describe('SigaaLink', () => {
  it('senha certa: guarda no cofre e faz 1 login + 1 GET do portal', async () => {
    const { http, requests } = fakeSigaa(true);
    const { cofre, aguardar } = fakeCofre();
    await new SigaaLink(cofre, http).conectar('txn-1', 'fulano', SENHA);
    expect(aguardar).toHaveBeenCalledWith('txn-1', { login: 'fulano', senha: SENHA });
    expect(requests.filter((r) => r.path.startsWith('/sigaa/logar.do'))).toHaveLength(1);
    expect(requests.filter((r) => r.path === '/sigaa/portais/discente/discente.jsf')).toHaveLength(1);
  });

  it('senha errada: erro amigável, nada guardado, sem a senha na mensagem', async () => {
    const { http } = fakeSigaa(false);
    const { cofre, aguardar } = fakeCofre();
    const erro = await new SigaaLink(cofre, http).conectar('txn-1', 'fulano', SENHA).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toContain('usuário ou senha do SIGAA incorretos');
    expect(String((erro as Error).message) + String((erro as Error).stack)).not.toContain(SENHA);
    expect(aguardar).not.toHaveBeenCalled();
  });

  it('pendente delega ao cofre', () => {
    const { cofre } = fakeCofre();
    const link = new SigaaLink(cofre, fakeSigaa(true).http);
    expect(link.pendente('txn-1')).toBe(true);
    expect(link.pendente('outra')).toBe(false);
  });
});
