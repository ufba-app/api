import { Secret } from '../../../application/shared/secret';
import type { SigaaHttpClient, SigaaHttpRequest, SigaaHttpResponse } from './http-client';
import { SigaaSessionExpiredError, SigaaSession } from './session';

const MENU = '/sigaa/ava/index.jsf';
const MAPA = '/sigaa/ava/FrequenciaAluno/mapa.jsf';

function res(p: Partial<SigaaHttpResponse>): SigaaHttpResponse {
  const body = p.body ?? '';
  return { status: 200, headers: {}, body, bodyBuffer: Buffer.from(body, 'latin1'), ...p };
}

/** Sessão retomada (sem login) sobre um HTTP falso que responde por caminho e método. */
function montar(responder: (req: SigaaHttpRequest) => SigaaHttpResponse) {
  const requests: SigaaHttpRequest[] = [];
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push(req);
      return responder(req);
    },
  };
  const sessao = new SigaaSession(http);
  sessao.resume(Secret.of('JSESSIONID=abc'));
  return { sessao, requests };
}

describe('SigaaSession.postback e o redirect do SIGAA', () => {
  it('302 para uma página do SIGAA: segue com GET e devolve o corpo dela', async () => {
    const { sessao, requests } = montar((req) =>
      req.method === 'POST' ? res({ status: 302, headers: { location: MAPA } }) : res({ body: '<p>mapa</p>' }),
    );
    await expect(sessao.postback(MENU, { formMenu: 'formMenu' })).resolves.toBe('<p>mapa</p>');
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${MENU}`, `GET ${MAPA}`]);
    expect(requests[1].cookie).toBe('JSESSIONID=abc');
  });

  it('Location absoluto: segue só pelo caminho (e a query)', async () => {
    const { sessao, requests } = montar((req) =>
      req.method === 'POST'
        ? res({ status: 302, headers: { location: `https://sigaa.ufba.br${MAPA}?x=1` } })
        : res({ body: 'ok' }),
    );
    await sessao.postback(MENU, {});
    expect(requests[1].path).toBe(`${MAPA}?x=1`);
  });

  it('o ViewState da página do redirect vale para o próximo postback', async () => {
    const { sessao, requests } = montar((req) =>
      req.method === 'POST' && req.path === MENU
        ? res({ status: 302, headers: { location: MAPA } })
        : req.method === 'GET'
          ? res({ body: '<input type="hidden" name="javax.faces.ViewState" value="vsDoMapa" />' })
          : res({ body: 'fim' }),
    );
    await sessao.postback(MENU, {});
    await sessao.postback('/sigaa/outra.jsf', {});
    expect(requests[2].body).toMatchObject({ 'javax.faces.ViewState': 'vsDoMapa' });
  });

  it('200 direto: nenhuma requisição a mais', async () => {
    const { sessao, requests } = montar(() => res({ body: '<p>direto</p>' }));
    await expect(sessao.postback(MENU, {})).resolves.toBe('<p>direto</p>');
    expect(requests).toHaveLength(1);
  });

  it('302 para fora de /sigaa/: não segue', async () => {
    const { sessao, requests } = montar(() => res({ status: 302, headers: { location: 'https://outro.exemplo/x' } }));
    await expect(sessao.postback(MENU, {})).resolves.toBe('');
    expect(requests).toHaveLength(1);
  });

  it('302 para expirada.jsp continua sendo sessão expirada', async () => {
    const { sessao } = montar(() => res({ status: 302, headers: { location: '/sigaa/expirada.jsp' } }));
    await expect(sessao.postback(MENU, {})).rejects.toBeInstanceOf(SigaaSessionExpiredError);
  });

  it('segue um redirect só: um segundo 302 devolve o corpo dele sem laço', async () => {
    const { sessao, requests } = montar(() => res({ status: 302, headers: { location: MAPA } }));
    await expect(sessao.postback(MENU, {})).resolves.toBe('');
    expect(requests).toHaveLength(2);
  });
});
