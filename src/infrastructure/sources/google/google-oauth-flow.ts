import type { FetchFn } from './google-http';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export class GoogleLinkError extends Error {}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  fetchFn?: FetchFn;
}

export interface UserInfo {
  email?: string;
  email_verified?: boolean;
  hd?: string;
}

/** Troca o code do callback por tokens. Mensagens sem corpo da resposta: ele pode conter o code/tokens. */
export async function exchangeCode(
  c: GoogleClient,
  code: string,
  callbackUrl: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  if (!code) throw new GoogleLinkError('O Google não devolveu o código de autorização');
  const res = await (c.fetchFn ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new GoogleLinkError(`Falha ao trocar o código no Google (${res.status})`);
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!tok.access_token) throw new GoogleLinkError('O Google não devolveu access token');
  return { access_token: tok.access_token, refresh_token: tok.refresh_token };
}

export async function userInfo(c: GoogleClient, accessToken: string): Promise<UserInfo> {
  const res = await (c.fetchFn ?? fetch)(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleLinkError(`Falha ao ler o e-mail da conta Google (${res.status})`);
  return (await res.json()) as UserInfo;
}
