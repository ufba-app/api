import type { SigaaHttpClient, SigaaHttpResponse } from './http-client';
import { Secret } from '../../../application/shared/secret';

/** Usuário e senha chegam por requisição; ficam só na variável local de `login` e nunca são guardados. */
export interface SigaaCredentials {
  login: string;
  password: Secret;
}

export class SigaaInvalidCredentialsError extends Error {
  constructor() {
    super('O SIGAA rejeitou usuário e/ou senha');
    this.name = 'SigaaInvalidCredentialsError';
  }
}

/**
 * O login não passou, mas o SIGAA não disse que a credencial está errada (formulário mudo,
 * bloqueio de borda, manutenção). Não acusar a senha. A mensagem leva uma impressão digital da
 * resposta (status, location, título), nunca o corpo.
 */
export class SigaaLoginUnavailableError extends Error {
  constructor(fingerprint: string) {
    super(`O SIGAA não concluiu o login: ${fingerprint}`);
    this.name = 'SigaaLoginUnavailableError';
  }
}

export class SigaaSessionExpiredError extends Error {
  constructor() {
    super('A sessão do SIGAA expirou');
    this.name = 'SigaaSessionExpiredError';
  }
}

const LOGIN_FORM_MARKER = '<form name="loginForm"';
const VIEW_STATE_PATTERN = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/;
const JSESSIONID_PATTERN = /JSESSIONID=[^;]+/;
const LOGIN_FORM_BLOCK_PATTERN = /<form[^>]*name="loginForm"[\s\S]*?<\/form>/i;
const FORM_ACTION_PATTERN = /<form[^>]*name="loginForm"[^>]*action="([^"]*)"/i;
const INPUT_PATTERN = /<input\b[^>]*>/gi;
const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');

/** Só estes textos autorizam acusar a credencial. */
const CREDENTIAL_REJECTION_MARKERS = [
  'senha inválidos',
  'senha inválida',
  'usuário e/ou senha',
];

/**
 * Sessão expirada em consulta pontual: o SIGAA responde 302 para `/sigaa/expirada.jsp`, sem corpo e sem cookie
 * (observado em 14/11/2026 com um JSESSIONID vencido). A página com o alerta "Sua sessão foi expirada" é a que o
 * navegador carrega ao seguir o redirect; como não seguimos redirects, o que chega aqui é só o 302.
 */
function isExpiredRedirect(r: SigaaHttpResponse): boolean {
  if (r.status !== 302 || !r.headers.location) return false;
  try {
    return new URL(r.headers.location, 'https://x.invalid').pathname === '/sigaa/expirada.jsp';
  } catch {
    return false;
  }
}

function isLoginFormResponse(r: SigaaHttpResponse): boolean {
  return (
    r.status === 200 &&
    (r.body.includes(LOGIN_FORM_MARKER) ||
      r.body.includes('Usuário e/ou senha inválidos'))
  );
}

function saysCredentialsAreWrong(body: string): boolean {
  const lowered = body.toLowerCase();
  return CREDENTIAL_REJECTION_MARKERS.some((m) => lowered.includes(m));
}

/** Campos ocultos do formulário de login, lidos da página (o JSF muda com as atualizações). */
export function hiddenLoginFormFields(html: string): Record<string, string> {
  const form = LOGIN_FORM_BLOCK_PATTERN.exec(html)?.[0];
  if (!form) return {};
  const fields: Record<string, string> = {};
  for (const input of form.match(INPUT_PATTERN) ?? []) {
    const name = attr('name').exec(input)?.[1];
    if (!name) continue;
    const type = (attr('type').exec(input)?.[1] ?? '').toLowerCase();
    if (type && type !== 'hidden') continue;
    fields[name] = attr('value').exec(input)?.[1] ?? '';
  }
  return fields;
}

export function loginFormAction(html: string): string | undefined {
  const action = FORM_ACTION_PATTERN.exec(html)?.[1];
  if (!action) return undefined;
  if (action.startsWith('/')) return action;
  try {
    const url = new URL(action);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function fingerprint(r: SigaaHttpResponse): string {
  const title = /<title>([\s\S]{0,120}?)<\/title>/i
    .exec(r.body)?.[1]
    ?.trim()
    .replace(/\s+/g, ' ');
  return [
    `status ${r.status}`,
    r.headers.location ? `location ${r.headers.location}` : undefined,
    title ? `title "${title}"` : undefined,
    r.body.includes(LOGIN_FORM_MARKER)
      ? 'login form returned'
      : `body ${r.body.length} bytes`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Sessão do SIGAA, só em memória: JSESSIONID e ViewState. Não guarda a credencial, então não
 * há novo login automático: se a sessão cair, lança `SigaaSessionExpiredError` e quem chama
 * pede a senha de novo. Descarte o objeto ao fim da sincronização.
 */
export class SigaaSession {
  private jsessionId: string | undefined;
  private viewState: string | undefined;

  constructor(private readonly http: SigaaHttpClient) {}

  /** Retoma uma sessão guardada (só o cookie; o ViewState nunca é guardado, cada consulta recomeça pelo portal). */
  resume(cookie: Secret): void {
    this.jsessionId = cookie.reveal();
    this.viewState = undefined;
  }

  /** Cookie atual da sessão, para guardar cifrado. `undefined` antes do login. */
  exportCookie(): Secret | undefined {
    return this.jsessionId ? Secret.of(this.jsessionId) : undefined;
  }

  async login(credentials: SigaaCredentials): Promise<void> {
    // A sessão precisa nascer na raiz (302 para /sigaa/public/home.jsf, semeia o JSESSIONID):
    // ir direto a um .do trava no "endereço inválido".
    this.captureCookie(await this.http.request({ method: 'GET', path: '/' }));

    const initial = await this.http.request({
      method: 'GET',
      path: '/sigaa/verTelaLogin.do',
      cookie: this.jsessionId,
    });
    this.captureCookie(initial);

    const response = await this.http.request({
      method: 'POST',
      path: loginFormAction(initial.body) ?? '/sigaa/logar.do?dispatch=logOn',
      cookie: this.jsessionId,
      referer: '/sigaa/verTelaLogin.do',
      body: {
        width: '1920',
        height: '1080',
        urlRedirect: '',
        subsistemaRedirect: '',
        acao: '',
        acessibilidade: '',
        ...hiddenLoginFormFields(initial.body),
        'user.login': credentials.login,
        'user.senha': credentials.password.reveal(),
      },
    });
    this.captureCookie(response);

    if (
      response.status === 302 &&
      (response.headers.location ?? '').includes('paginaInicial.do')
    ) {
      // Seguir o redirect: o JSF guarda estado de navegação no servidor.
      this.captureCookie(
        await this.http.request({
          method: 'GET',
          path: '/sigaa/paginaInicial.do',
          cookie: this.jsessionId,
        }),
      );
      return;
    }

    if (saysCredentialsAreWrong(response.body)) {
      throw new SigaaInvalidCredentialsError();
    }
    throw new SigaaLoginUnavailableError(fingerprint(response));
  }

  async get(path: string): Promise<string> {
    const response = await this.authenticated({ method: 'GET', path });
    return response.body;
  }

  async postback(
    path: string,
    fields: Record<string, string>,
  ): Promise<string> {
    const response = await this.authenticated({
      method: 'POST',
      path,
      body: { ...fields, 'javax.faces.ViewState': this.viewState ?? '' },
    });
    return (await this.followSigaaRedirect(response)).body;
  }

  /**
   * Alguns cliques do menu da turma (ex.: "Frequência") respondem 302 para a página de destino, e o navegador a
   * carrega sozinho. Segue UM redirect para dentro de `/sigaa/` com GET (capturando o ViewState da página nova);
   * qualquer outro destino, ou um 200, volta como veio. `expirada.jsp` já virou erro em `authenticated`.
   */
  private async followSigaaRedirect(response: SigaaHttpResponse): Promise<SigaaHttpResponse> {
    if (response.status !== 302 || !response.headers.location) return response;
    let destino: URL;
    try {
      destino = new URL(response.headers.location, 'https://x.invalid');
    } catch {
      return response;
    }
    if (!destino.pathname.startsWith('/sigaa/')) return response;
    return this.authenticated({ method: 'GET', path: `${destino.pathname}${destino.search}` });
  }

  /**
   * Postback cujo resultado são bytes. O portal clássico responde o PDF direto no 200; o fluxo
   * mobile responderia 302 para um endpoint gerador, que seguimos.
   */
  async postbackBinary(
    path: string,
    fields: Record<string, string>,
  ): Promise<Buffer> {
    const response = await this.authenticated(
      {
        method: 'POST',
        path,
        body: { ...fields, 'javax.faces.ViewState': this.viewState ?? '' },
      },
      false,
    );

    if (response.status === 302 && response.headers.location) {
      const location = new URL(response.headers.location, 'https://x.invalid');
      const binary = await this.authenticated(
        {
          method: 'GET',
          path: `${location.pathname}${location.search}`,
        },
        false,
      );
      if (!binary.bodyBuffer) throw new Error('Corpo binário esperado');
      return binary.bodyBuffer;
    }
    if (response.status === 200 && response.bodyBuffer) {
      return response.bodyBuffer;
    }
    throw new Error(
      `Esperava bytes do postback (direto ou por redirect), veio status ${response.status}`,
    );
  }

  private async authenticated(
    req: {
      method: 'GET' | 'POST';
      path: string;
      body?: Record<string, string>;
    },
    capturesViewState = true,
  ): Promise<SigaaHttpResponse> {
    if (!this.jsessionId) {
      throw new Error('SigaaSession.login precisa ter sucesso antes');
    }
    const response = await this.http.request({
      ...req,
      cookie: this.jsessionId,
    });
    this.captureCookie(response);
    if (isLoginFormResponse(response) || isExpiredRedirect(response)) throw new SigaaSessionExpiredError();
    if (capturesViewState) this.captureViewState(response.body);
    return response;
  }

  private captureCookie(response: SigaaHttpResponse): void {
    const match = JSESSIONID_PATTERN.exec(response.headers['set-cookie'] ?? '');
    if (match) this.jsessionId = match[0];
  }

  private captureViewState(body: string): void {
    const match = VIEW_STATE_PATTERN.exec(body);
    if (match) this.viewState = match[1];
  }
}
