import { GoogleLinkError, GoogleOAuthLink, GOOGLE_LOGIN_SCOPES } from './google-oauth-link';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function build(userinfo: Record<string, unknown>, cfg: { allowedDomain?: string } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/token')) return jsonRes({ access_token: 'AT', refresh_token: 'RT' });
    if (u.includes('userinfo')) return jsonRes(userinfo);
    return jsonRes({}, 404);
  }) as typeof fetch;
  const link = new GoogleOAuthLink({ clientId: 'cid', clientSecret: 'sec', fetchFn, allowedDomain: cfg.allowedDomain });
  return { link, calls };
}

describe('GoogleOAuthLink: login', () => {
  it('só está habilitado com client id e secret', () => {
    expect(build({}).link.loginEnabled()).toBe(true);
    expect(new GoogleOAuthLink({}).loginEnabled()).toBe(false);
  });

  it('a URL de login pede só identidade, com hd=ufba.br', async () => {
    const url = new URL(await build({}).link.startLoginUrl('http://localhost:3000/oauth/callback/google', 'txn1'));
    expect(url.searchParams.get('scope')).toBe(GOOGLE_LOGIN_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).not.toContain('classroom');
    expect(url.searchParams.get('hd')).toBe('ufba.br');
    expect(url.searchParams.get('state')).toBe('txn1');
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('aceita conta @ufba.br verificada (e normaliza para minúsculas)', async () => {
    const { link } = build({ email: 'Luiz.A@UFBA.br', email_verified: true, hd: 'ufba.br' });
    await expect(link.handleLoginCallback('code', 'cb')).resolves.toEqual({ email: 'luiz.a@ufba.br' });
  });

  it.each([
    ['gmail pessoal', { email: 'x@gmail.com', email_verified: true }],
    ['domínio parecido', { email: 'x@ufba.br.evil.com', email_verified: true, hd: 'ufba.br.evil.com' }],
    ['e-mail ufba.br sem hd (não é conta Workspace)', { email: 'x@ufba.br', email_verified: true }],
    ['e-mail não verificado', { email: 'x@ufba.br', email_verified: false, hd: 'ufba.br' }],
  ])('recusa %s', async (_n, info) => {
    await expect(build(info).link.handleLoginCallback('code', 'cb')).rejects.toThrow(GoogleLinkError);
  });

  it('recusa quando o Google não devolve o code (usuário cancelou)', async () => {
    const { link } = build({ email: 'x@ufba.br', email_verified: true, hd: 'ufba.br' });
    await expect(link.handleLoginCallback('', 'cb')).rejects.toThrow('código');
  });

  it('o login não chama nenhuma API de conteúdo', async () => {
    const { link, calls } = build({ email: 'x@ufba.br', email_verified: true, hd: 'ufba.br' });
    await link.handleLoginCallback('code', 'cb');
    expect(calls.some((c) => c.includes('classroom'))).toBe(false);
  });
});
