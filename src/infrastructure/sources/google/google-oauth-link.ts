import type { GoogleLinkPort } from '../../../application/oauth/oauth-ports';
import type { FetchFn } from './google-http';
import { exchangeCode, GOOGLE_AUTH_URL, GoogleLinkError, userInfo } from './google-oauth-flow';

export { GoogleLinkError } from './google-oauth-flow';

/** Login: só identidade. O Classroom é conectado à parte, por outro app OAuth (ver `ClassroomLink`). */
export const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'];

/**
 * LOGIN do serviço com Google (app OAuth INTERNO da organização, `GOOGLE_CLIENT_ID/SECRET`): só openid/email/profile
 * e só o domínio `GOOGLE_ALLOWED_DOMAIN` (padrão ufba.br), conferido aqui no servidor (e-mail verificado + claim `hd`).
 * Não guarda nada: só identifica a pessoa. Redirect: `<PUBLIC_URL>/oauth/callback/google`.
 */
export class GoogleOAuthLink implements GoogleLinkPort {
  constructor(
    private readonly cfg: { clientId?: string; clientSecret?: string; allowedDomain?: string; fetchFn?: FetchFn } = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN,
    },
  ) {}

  private client() {
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new GoogleLinkError('Google não configurado: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET');
    }
    return { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, fetchFn: this.cfg.fetchFn };
  }

  private domain(): string {
    return (this.cfg.allowedDomain || 'ufba.br').toLowerCase();
  }

  loginEnabled(): boolean {
    return !!(this.cfg.clientId && this.cfg.clientSecret);
  }

  async startLoginUrl(callbackUrl: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.client().clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: GOOGLE_LOGIN_SCOPES.join(' '),
      prompt: 'select_account',
      hd: this.domain(), // só dica de UI; a checagem de verdade é em handleLoginCallback
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async handleLoginCallback(code: string, callbackUrl: string): Promise<{ email: string }> {
    const c = this.client();
    const tok = await exchangeCode(c, code, callbackUrl);
    const info = await userInfo(c, tok.access_token);
    const email = info.email?.toLowerCase();
    if (!email) throw new GoogleLinkError('Conta Google sem e-mail');
    const d = this.domain();
    if (info.email_verified !== true || info.hd?.toLowerCase() !== d || !email.endsWith(`@${d}`)) {
      throw new GoogleLinkError(`${email} não é um e-mail @${d}. Entre com a sua conta institucional.`);
    }
    return { email };
  }
}
