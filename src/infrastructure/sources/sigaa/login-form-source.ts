import { SigaaLoginFormSource, type SigaaLoginForm } from '../../../application/ports/sigaa-launch';
import { SourceError } from '../../../application/ports/source-gateway';
import { createSigaaHttpClient, type SigaaHttpClient } from './http-client';
import { hiddenLoginFormFields, loginFormAction } from './session';

const DEFAULT_ACTION = '/sigaa/logar.do?dispatch=logOn';

/**
 * Lê o formulário de login do SIGAA (anônimo, sem credencial): a sessão nasce na raiz (302 que semeia o JSESSIONID) e depois
 * vem `verTelaLogin.do`, como o login do servidor faz. Só devolve o que a PÁGINA diz (action e campos ocultos); o cookie
 * desta leitura fica aqui e nunca sai.
 */
export class HttpSigaaLoginFormSource extends SigaaLoginFormSource {
  constructor(private readonly http: SigaaHttpClient = createSigaaHttpClient()) {
    super();
  }

  async fetch(): Promise<SigaaLoginForm> {
    try {
      const root = await this.http.request({ method: 'GET', path: '/' });
      const cookie = /JSESSIONID=([^;]+)/.exec(root.headers['set-cookie'] ?? '')?.[1];
      const page = await this.http.request({ method: 'GET', path: '/sigaa/verTelaLogin.do', ...(cookie ? { cookie } : {}) });
      if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
      return {
        action: loginFormAction(page.body) ?? DEFAULT_ACTION,
        fields: {
          width: '1920',
          height: '1080',
          urlRedirect: '',
          subsistemaRedirect: '',
          acao: '',
          acessibilidade: '',
          ...hiddenLoginFormFields(page.body),
        },
      };
    } catch {
      throw new SourceError('UNAVAILABLE', 'Não foi possível ler a página de login do SIGAA agora.');
    }
  }
}
