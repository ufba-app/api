import { Secret } from '../../../application/shared/secret';
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

function fakeSigaa(loginOk: boolean | (() => boolean), fora = false) {
  const requests: SigaaHttpRequest[] = [];
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push(req);
      if (fora) throw new Error('rede fora');
      if (req.path === '/') return res({ status: 302, headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } });
      if (req.path === '/sigaa/verTelaLogin.do') return res({ body: LOGIN_PAGE });
      if (req.path.startsWith('/sigaa/logar.do')) {
        return (typeof loginOk === 'function' ? loginOk() : loginOk)
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
    await new SigaaLink(cofre, http).conectar('txn-1', 'fulano', Secret.of(SENHA), 'u1');
    expect(aguardar).toHaveBeenCalledWith('txn-1', { login: 'fulano', senha: expect.any(Secret) });
    expect(aguardar.mock.calls[0][1].senha.reveal()).toBe(SENHA);
    expect(requests.filter((r) => r.path.startsWith('/sigaa/logar.do'))).toHaveLength(1);
    expect(requests.filter((r) => r.path === '/sigaa/portais/discente/discente.jsf')).toHaveLength(1);
  });

  it('senha errada: erro amigável, nada guardado, sem a senha na mensagem', async () => {
    const { http } = fakeSigaa(false);
    const { cofre, aguardar } = fakeCofre();
    const erro = await new SigaaLink(cofre, http).conectar('txn-1', 'fulano', Secret.of(SENHA), 'u1').catch((e: Error) => e);
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

  describe('limite de tentativas', () => {
    const MUITAS = 'Muitas tentativas';
    const logins = (reqs: SigaaHttpRequest[]) => reqs.filter((r) => r.path.startsWith('/sigaa/logar.do')).length;

    function build(loginOk: boolean | (() => boolean) = false) {
      let agora = 1_000_000;
      const sigaa = fakeSigaa(loginOk);
      const { cofre, aguardar } = fakeCofre();
      const link = new SigaaLink(cofre, sigaa.http, () => agora);
      return { link, sigaa, aguardar, avancar: (ms: number) => (agora += ms) };
    }
    const tentar = (link: SigaaLink, txn: string, user = 'u1', login = 'fulano') =>
      link.conectar(txn, login, Secret.of(SENHA), user).then(
        () => null,
        (e: Error) => e,
      );

    it('4ª senha errada na mesma transação: recusa sem falar com o SIGAA e sem a senha na mensagem', async () => {
      const { link, sigaa } = build();
      for (let i = 0; i < 3; i++) expect((await tentar(link, 'txn-a'))!.message).toContain('incorretos');
      expect(logins(sigaa.requests)).toBe(3);
      const antes = sigaa.requests.length;
      const erro = (await tentar(link, 'txn-a'))!;
      expect(erro.message).toContain(MUITAS);
      expect(String(erro.message) + String(erro.stack)).not.toContain(SENHA);
      expect(sigaa.requests.length).toBe(antes);
    });

    it('limite por usuário: 5 falhas em transações e logins diferentes bloqueiam a 6ª', async () => {
      const { link, sigaa } = build();
      for (const [txn, login] of [['t1', 'a'], ['t1', 'b'], ['t2', 'c'], ['t2', 'd'], ['t3', 'e']]) {
        expect((await tentar(link, txn, 'u1', login))!.message).toContain('incorretos');
      }
      const antes = sigaa.requests.length;
      expect((await tentar(link, 't4', 'u1', 'f'))!.message).toContain(MUITAS);
      expect(sigaa.requests.length).toBe(antes);
      // outro usuário, outro login: não é afetado
      expect((await tentar(link, 't5', 'u2', 'g'))!.message).toContain('incorretos');
    });

    it('limite por login do SIGAA: trocar de transação e de conta não reinicia', async () => {
      const { link, sigaa } = build();
      for (let i = 0; i < 5; i++) {
        expect((await tentar(link, `t${i}`, `u${i}`, 'vitima'))!.message).toContain('incorretos');
      }
      const antes = sigaa.requests.length;
      // caixa e espaços diferentes: mesmo login
      expect((await tentar(link, 't9', 'u9', '  VITIMA '))!.message).toContain(MUITAS);
      expect(sigaa.requests.length).toBe(antes);
      expect((await tentar(link, 't10', 'u10', 'outro'))!.message).toContain('incorretos');
    });

    it('tentativas em paralelo não passam todas pela checagem: a reserva vem antes de falar com o SIGAA', async () => {
      const { link, sigaa } = build();
      const erros = await Promise.all(Array.from({ length: 10 }, () => tentar(link, 'txn-a')));
      expect(logins(sigaa.requests)).toBe(3);
      expect(erros.filter((e) => e!.message.includes('incorretos'))).toHaveLength(3);
      expect(erros.filter((e) => e!.message.includes(MUITAS))).toHaveLength(7);
    });

    it('sucesso zera o contador do login', async () => {
      let ok = false;
      const { link } = build(() => ok);
      for (let i = 0; i < 4; i++) await tentar(link, `t${i}`, `u${i}`, 'dono');
      ok = true;
      expect(await tentar(link, 't8', 'u8', 'dono')).toBeNull();
      ok = false;
      for (let i = 0; i < 3; i++) expect((await tentar(link, `x${i}`, `v${i}`, 'dono'))!.message).toContain('incorretos');
    });

    it('sucesso zera o contador da transação', async () => {
      let ok = false;
      const { link, aguardar } = build(() => ok);
      await tentar(link, 'txn-a');
      await tentar(link, 'txn-a');
      ok = true;
      expect(await tentar(link, 'txn-a')).toBeNull();
      expect(aguardar).toHaveBeenCalledTimes(1);
      ok = false;
      for (let i = 0; i < 2; i++) expect((await tentar(link, 'txn-a'))!.message).toContain('incorretos');
    });

    it('a janela expira em 15 minutos', async () => {
      const { link, sigaa, avancar } = build();
      for (let i = 0; i < 3; i++) await tentar(link, 'txn-a');
      expect((await tentar(link, 'txn-a'))!.message).toContain(MUITAS);
      avancar(15 * 60 * 1000 + 1);
      const antes = logins(sigaa.requests);
      expect((await tentar(link, 'txn-a'))!.message).toContain('incorretos');
      expect(logins(sigaa.requests)).toBe(antes + 1);
    });

    it('SIGAA indisponível não conta como tentativa', async () => {
      const sigaa = fakeSigaa(false, true);
      const { cofre } = fakeCofre();
      const link = new SigaaLink(cofre, sigaa.http, () => 0);
      for (let i = 0; i < 6; i++) {
        expect((await tentar(link, 'txn-a'))!.message).toContain('Não consegui falar com o SIGAA');
      }
    });
  });
});
