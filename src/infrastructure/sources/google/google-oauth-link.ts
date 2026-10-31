import type { IdentityService } from '../../../application/identity/identity.service';
import type { GoogleLinkPort, LinkStatus } from '../../../application/oauth/oauth-ports';
import type { SourceAccountRepository } from '../../../application/ports/repositories';
import type { FetchFn } from './google-http';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Somente leitura (docs/GOOGLE.md) + e-mail, que vira o `accountKey` da conta. */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

export class GoogleLinkError extends Error {}

/**
 * Vínculo com o Google pela tela de /authorize: fluxo OAuth (code) com GOOGLE_CLIENT_ID/SECRET. O refresh token vai
 * cifrado para a conta CLASSROOM e para a CALENDAR (`IdentityService.conectarConta`); nada é logado.
 * O `redirect_uri` (`<PUBLIC_URL>/oauth/callback/google`) precisa estar cadastrado no cliente OAuth do Google.
 */
export class GoogleOAuthLink implements GoogleLinkPort {
  constructor(
    private readonly identity: IdentityService,
    private readonly accounts: SourceAccountRepository,
    private readonly cfg: { clientId?: string; clientSecret?: string; fetchFn?: FetchFn } = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  ) {}

  private credentials(): { clientId: string; clientSecret: string } {
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new GoogleLinkError('Google não configurado: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET');
    }
    return { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret };
  }

  async status(userId: string): Promise<LinkStatus> {
    const accounts = await this.accounts.findByUserAndProvider(userId, 'CLASSROOM');
    return { connected: accounts.some((a) => a.secret !== null) };
  }

  async startUrl(_userId: string, callbackUrl: string, state: string): Promise<string> {
    const { clientId } = this.credentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async handleCallback(userId: string, code: string, callbackUrl: string): Promise<void> {
    const { clientId, clientSecret } = this.credentials();
    if (!code) throw new GoogleLinkError('O Google não devolveu o código de autorização');
    const f = this.cfg.fetchFn ?? fetch;

    const res = await f(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      }),
    });
    // Mensagens sem corpo da resposta: ele pode conter o code/tokens.
    if (!res.ok) throw new GoogleLinkError(`Falha ao trocar o código no Google (${res.status})`);
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!tok.refresh_token || !tok.access_token) {
      throw new GoogleLinkError(
        'O Google não devolveu refresh token; revogue o acesso em myaccount.google.com/permissions e tente de novo',
      );
    }

    const info = await f(USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!info.ok) throw new GoogleLinkError(`Falha ao ler o e-mail da conta Google (${info.status})`);
    const email = ((await info.json()) as { email?: string }).email;
    if (!email) throw new GoogleLinkError('Conta Google sem e-mail');

    for (const provider of ['CLASSROOM', 'CALENDAR'] as const) {
      await this.identity.conectarConta({
        userId,
        provider,
        accountKey: email,
        secretPlain: tok.refresh_token,
      });
    }
  }
}
