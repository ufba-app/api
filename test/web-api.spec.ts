/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { Secret } from '../src/application/shared/secret';
import { UpsertSourceAccountInput } from '../src/application/ports/repositories';
import { ClientDirectory } from '../src/application/oauth/client-directory';
import {
  GOOGLE_LINK,
  LinkError,
  OAUTH_STORE,
  SIGAA_LINK,
  MOODLE_LINK,
  type VerifiedMoodleAccount,
  USER_DIRECTORY,
  type GoogleLinkPort,
  type SigaaLinkPort,
} from '../src/application/oauth/oauth-ports';
import { OAuthService, splitToken } from '../src/application/oauth/oauth.service';
import {
  ApiKeyRepository,
  SigaaCredentialRepository,
  SourceAccountRecord,
  SourceBindingRepository,
  SourceAccountRepository,
  UserRepository,
  type EncryptedSecret,
  type SigaaCredentialRecord,
} from '../src/application/ports/repositories';
import { CofreSigaa } from '../src/application/sigaa/cofre-sigaa';
import { MemoryProjectRepository } from '../src/application/memory/project-ports';
import { WEB_CLIENT_ID } from '../src/application/web/web-api';
import { InMemoryProjectRepo } from './support/memory-fakes';
import { WebSessionService } from '../src/application/web/web-session.service';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { OAUTH_SERVICE } from '../src/interface/mcp/oauth/oauth.controller';
import { MemoryOAuthStore, MemoryUserDirectory } from '../src/interface/mcp/testing/memory-oauth-store';
import { CLIENT_DIRECTORY } from '../src/interface/web/web-tokens';

const WEB = 'http://localhost:3001';
const AUTH = 'http://localhost:3002';
const WEB_CB = `${AUTH}/sign-in/callback`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const META_ID = 'https://app.example/oauth/client.json';
const META_CB = 'https://app.example/callback';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
// Marca única: o teste "canário" no fim confere que ela nunca saiu em log, erro ou resposta.
const SENHA = 'CANARIO-web-7d1e-senha';

const pkce = () => {
  const verifier = 'v'.repeat(64);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Fluxo completo do app web pelo AppModule real, com banco e fontes falsos: sem rede. */
describe('API do app web (docs/WEB-API.md)', () => {
  let app: INestApplication;
  let base: string;
  let oauth: OAuthService;
  let store: MemoryOAuthStore;
  let cofre: CofreSigaa;
  const creds = new Map<string, SigaaCredentialRecord>();
  const accounts: SourceAccountRecord[] = [];
  const sigaaValidations: string[] = [];
  // Exclusão de conta: o banco apaga em cascata; aqui, o diretório falso apaga os vínculos e contas da pessoa.
  const users = new (class extends MemoryUserDirectory {
    override async deleteAccount(userId: string): Promise<void> {
      await super.deleteAccount(userId);
      for (let i = bindingRows.length - 1; i >= 0; i--) if (bindingRows[i].userId === userId) bindingRows.splice(i, 1);
      for (let i = accounts.length - 1; i >= 0; i--) if (accounts[i].userId === userId) accounts.splice(i, 1);
      for (const [k, c] of creds) if (c.userId === userId) creds.delete(k);
    }
  })();
  // O que o "AVA" diz do token capturado (cada teste ajusta).
  let moodleAccount: Omit<VerifiedMoodleAccount, 'token'> = {
    siteUrl: 'https://ava.ufba.br',
    host: 'ava.ufba.br',
    moodleUserId: 1,
    username: 'fulano',
    auth: 'shibboleth',
  };
  const moodle = {
    scheme: () => 'web+ufba',
    launchUrl: async () => 'https://ava.ufba.br/admin/tool/mobile/launch.php',
    verify: async (): Promise<VerifiedMoodleAccount> => ({ ...moodleAccount, token: Secret.of('wstoken-de-teste') }),
  };
  // Vínculos em memória, com a mesma unicidade dos dois lados que o banco impõe.
  const bindingRows: { userId: string; source: string; hash: string }[] = [];
  const bindings = {
    findMine: async (u: string, s: string) => bindingRows.find((r) => r.userId === u && r.source === s)?.hash ?? null,
    findOwner: async (s: string, h: string) => bindingRows.find((r) => r.source === s && r.hash === h)?.userId ?? null,
    create: async (u: string, s: string, h: string) => {
      if (bindingRows.some((r) => (r.userId === u && r.source === s) || (r.source === s && r.hash === h))) return false;
      bindingRows.push({ userId: u, source: s, hash: h });
      return true;
    },
  };

  const google: GoogleLinkPort = {
    loginEnabled: () => true,
    startLoginUrl: async (_cb, state) => `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    handleLoginCallback: async (code) => {
      if (code === 'gmail') throw new Error('marina@gmail.com não é um e-mail @ufba.br. Entre com a sua conta institucional.');
      return { email: `${code}@ufba.br` };
    },
  };
  const sigaa: SigaaLinkPort = {
    validar: async (_k, login, senha) => {
      sigaaValidations.push(login);
      if (senha.reveal() !== SENHA) throw new LinkError('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
      return login.trim();
    },
  };

  // Tudo o que o processo escreveria no terminal/log durante a suíte (ver o último teste, "canário").
  const saida: string[] = [];
  const guardar = (...a: unknown[]) =>
    void saida.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 10 }))).join(' '));
  const espioes = [
    jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (guardar(String(c)), true)),
    jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (guardar(String(c)), true)),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(guardar)),
  ];

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.WEB_ORIGIN = WEB;
    process.env.AUTH_ORIGIN = AUTH;
    process.env.PUBLIC_URL = 'http://localhost:3000';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.OAUTH_AUTHORIZE_SECRET;
    const { AppModule } = await import('../src/app.module');
    store = new MemoryOAuthStore();

    const clients = new ClientDirectory(
      store,
      {
        fetchDocument: async (url) => {
          if (url !== META_ID) throw new Error('offline');
          return { client_id: META_ID, client_name: 'App‮ Exemplo  ', redirect_uris: [META_CB], logo_uri: 'https://app.example/logo.png' };
        },
        fetchLogo: async () => ({ mime: 'image/png', bytes: PNG }),
      },
      {
        match: (host) => (host === 'claude.ai' ? { domain: 'claude.ai', name: 'Claude' } : undefined),
        logo: () => null,
      },
      () => 'http://localhost:3000',
    );

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OAUTH_STORE)
      .useValue(store)
      .overrideProvider(USER_DIRECTORY)
      .useValue(users)
      .overrideProvider(CLIENT_DIRECTORY)
      .useValue(clients)
      .overrideProvider(GOOGLE_LINK)
      .useValue(google)
      .overrideProvider(SIGAA_LINK)
      .useValue(sigaa)
      .overrideProvider(MOODLE_LINK)
      .useValue(moodle)
      .overrideProvider(MemoryProjectRepository)
      .useValue(new InMemoryProjectRepo())
      .overrideProvider(UserRepository)
      .useValue({})
      .overrideProvider(ApiKeyRepository)
      .useValue({ findActiveByHash: async () => null })
      .overrideProvider(SourceBindingRepository)
      .useValue(bindings)
      .overrideProvider(SigaaCredentialRepository)
      .useValue({
        upsert: async (i: { userId: string; clientId: string; login: string; secret: EncryptedSecret }) => {
          const rec: SigaaCredentialRecord = { id: `${i.userId}:${i.clientId}`, ...i, status: 'OK', createdAt: new Date() };
          creds.set(rec.id, rec);
          return rec;
        },
        find: async (u: string, c: string) => creds.get(`${u}:${c}`) ?? null,
        setStatus: async () => undefined,
        delete: async (u: string, c: string) => void creds.delete(`${u}:${c}`),
      })
      .overrideProvider(SourceAccountRepository)
      .useValue({
        upsert: async (i: UpsertSourceAccountInput) => {
          const rec: SourceAccountRecord = {
            id: `${i.userId}:${i.provider}:${i.accountKey}`,
            userId: i.userId,
            provider: i.provider,
            accountKey: i.accountKey,
            siteUrl: i.siteUrl ?? null,
            status: 'OK',
            lastSyncedAt: null,
            secret: i.secret ?? null,
          };
          const at = accounts.findIndex((a) => a.id === rec.id);
          if (at >= 0) accounts[at] = rec;
          else accounts.push(rec);
          return rec;
        },
        findByUserAndProvider: async (u: string, p: string) => accounts.filter((a) => a.userId === u && a.provider === p),
        listByUser: async (u: string) => accounts.filter((a) => a.userId === u),
        setStatus: async () => undefined,
        delete: async (id: string) => {
          const i = accounts.findIndex((a) => a.id === id);
          if (i >= 0) accounts.splice(i, 1);
        },
      })
      .compile();

    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    oauth = mod.get(OAUTH_SERVICE);
    cofre = mod.get(CofreSigaa);
    await mod.get(WebSessionService).ensureWebClient();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.WEB_ORIGIN;
    delete process.env.AUTH_ORIGIN;
    delete process.env.PUBLIC_URL;
    for (const e of espioes) e.mockRestore();
  });

  const get = (path: string, cookie?: string) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  const send = (method: string, path: string, opts: { cookie?: string; body?: unknown; csrf?: boolean } = {}) =>
    fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.csrf === false ? {} : { 'x-ufba': '1', origin: WEB }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let ultimosCookies: string[] = [];

  /** Login completo do web; devolve o cookie `nome=valor`. */
  async function signIn(who = 'fulano'): Promise<string> {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: WEB_CLIENT_ID,
      redirect_uri: WEB_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st1',
    });
    const a = await get(`/authorize?${q}`);
    expect(a.status).toBe(303);
    const google = new URL(a.headers.get('location')!);
    expect(google.host).toBe('accounts.google.test');

    const cb = await get(`/oauth/callback/google?code=${who}&state=${google.searchParams.get('state')}`);
    expect(cb.status).toBe(303);
    const back = new URL(cb.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(WEB_CB);
    expect(back.searchParams.get('state')).toBe('st1');

    const s = await send('POST', '/session', {
      body: { code: back.searchParams.get('code'), codeVerifier: verifier, redirectUri: WEB_CB },
    });
    expect(s.status).toBe(204);
    ultimosCookies = s.headers.getSetCookie();
    const setCookie = s.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^ufba_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    return setCookie.split(';')[0];
  }

  it('login do web: Google → code → POST /session → cookie → /me', async () => {
    const cookie = await signIn();
    const me = await (await get('/me', cookie)).json() as any;
    expect(me.email).toBe('fulano@ufba.br');
    expect(me.connections.sigaa).toEqual({ status: 'disconnected', login: null });
    expect(me.connections.moodle.status).toBe('disconnected');
  });

  it('cookie marcador: sai com a sessão, sem segredo, e some ao sair, ao excluir a conta e no 401', async () => {
    const cookie = await signIn('marcador');
    expect(ultimosCookies).toHaveLength(2);
    expect(ultimosCookies[0]).toMatch(/^ufba_session=/);
    // Dev (http localhost): sem Secure e sem Domain.
    expect(ultimosCookies[1]).toMatch(/^ufba_signed_in=1; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

    const out = await send('DELETE', '/session', { cookie });
    const apagados = out.headers.getSetCookie();
    expect(apagados).toHaveLength(2);
    expect(apagados.some((c) => /^ufba_session=; .*Max-Age=0/.test(c))).toBe(true);
    expect(apagados).toContain('ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

    const semSessao = await get('/me');
    expect(semSessao.status).toBe(401);
    expect(semSessao.headers.getSetCookie()).toEqual(['ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);

    const c2 = await signIn('marcador2');
    const del = await send('DELETE', '/me', { cookie: c2 });
    expect(del.status).toBe(204);
    expect(del.headers.getSetCookie().some((c) => c.startsWith('ufba_signed_in=; ') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('GET /me com sessão válida reemite o marcador (quem entrou antes dele); sessão inválida não emite', async () => {
    const cookie = await signIn('marcador3');
    const r = await get('/me', cookie);
    expect(r.status).toBe(200);
    const cs = r.headers.getSetCookie();
    expect(cs).toHaveLength(1);
    const m = /^ufba_signed_in=1; Path=\/; HttpOnly; SameSite=Lax; Max-Age=(\d+)$/.exec(cs[0]);
    expect(m).not.toBeNull();
    const resta = Number(m![1]);
    expect(resta).toBeGreaterThan(29 * 24 * 3600); // o que resta da sessão (30 dias renovados no uso)
    expect(resta).toBeLessThanOrEqual(30 * 24 * 3600);
    expect(cs[0]).not.toContain(cookie.split('=')[1]);

    // Sessão inválida: nada de marcador novo; o 401 session_expired apaga, como já fazia.
    const ruim = await get('/me', 'ufba_session=lixo.lixo');
    expect(ruim.status).toBe(401);
    expect(ruim.headers.getSetCookie()).toEqual(['ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
  });

  it('conta fora do domínio volta ao web com a mensagem pronta (com o e-mail)', async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: WEB_CLIENT_ID,
      redirect_uri: WEB_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st2',
    });
    const a = await get(`/authorize?${q}`);
    const state = new URL(a.headers.get('location')!).searchParams.get('state');
    const cb = await get(`/oauth/callback/google?code=gmail&state=${state}`);
    const back = new URL(cb.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('error_description')).toContain('marina@gmail.com não é um e-mail @ufba.br');
    expect(back.searchParams.get('state')).toBe('st2');
  });

  it('CSRF: sem X-UFBA ou com Origin errado é recusado', async () => {
    const r1 = await send('POST', '/session', { body: {}, csrf: false });
    expect(r1.status).toBe(403);
    expect(await r1.json() as any).toEqual({ error: 'csrf_rejected', message: expect.any(String) });

    const cookie = await signIn();
    const r2 = await fetch(`${base}/connections/sigaa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: 'https://evil.example', cookie },
      body: JSON.stringify({ login: 'a', password: SENHA }),
    });
    expect(r2.status).toBe(403);
  });

  it('CSRF: aceita as duas origens da casa (painel e auth), recusa subdomínio que não é da casa', async () => {
    const cookie = await signIn();
    const post = (origin: string) =>
      fetch(`${base}/connections/sigaa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ufba': '1', origin, cookie },
        body: JSON.stringify({ login: 'a', password: SENHA }),
      });
    expect((await post(WEB)).status).toBe(204);
    expect((await post(AUTH)).status).toBe(204);
    expect((await post('http://localhost:3003')).status).toBe(403);
  });

  it('WEB_ORIGIN em lista (transição): a segunda origem também passa no CSRF', async () => {
    const cookie = await signIn();
    const OUTRA = 'http://localhost:3004';
    const post = (origin: string) =>
      fetch(`${base}/connections/sigaa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ufba': '1', origin, cookie },
        body: JSON.stringify({ login: 'a', password: SENHA }),
      });
    expect((await post(OUTRA)).status).toBe(403);
    process.env.WEB_ORIGIN = `${WEB},${OUTRA}`;
    try {
      expect((await post(WEB)).status).toBe(204);
      expect((await post(OUTRA)).status).toBe(204);
    } finally {
      process.env.WEB_ORIGIN = WEB;
    }
  });

  it('sem sessão: 401 session_expired', async () => {
    const r = await get('/me');
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toBe('session_expired');
    expect((await get('/me', 'ufba_session=lixo')).status).toBe(401);
  });

  it('SIGAA: senha errada 422; certa 204 e /me connected', async () => {
    const cookie = await signIn('sigaa1');
    const bad = await send('POST', '/connections/sigaa', { cookie, body: { login: 'aluno', password: 'errada' } });
    expect(bad.status).toBe(422);
    expect((await bad.json() as any).error).toBe('invalid_credentials');

    const ok = await send('POST', '/connections/sigaa', { cookie, body: { login: ' aluno ', password: SENHA } });
    expect(ok.status).toBe(204);
    const me = await (await get('/me', cookie)).json() as any;
    expect(me.connections.sigaa).toEqual({ status: 'connected', login: 'aluno' });

    // Outra sessão da mesma pessoa não abre a senha (K diferente): pede de novo.
    const other = await signIn('sigaa1');
    const me2 = await (await get('/me', other)).json() as any;
    expect(me2.connections.sigaa.status).toBe('password_required');
  });

  it('autorizar terceiro: mostra quem pede sem login, aprova e o SIGAA vai junto com K nova', async () => {
    const cookie = await signIn('aprova');
    await send('POST', '/connections/sigaa', { cookie, body: { login: 'aprova', password: SENHA } });
    const me = await (await get('/me', cookie)).json() as any;

    const c = await oauth.registerClient({ redirect_uris: [CLAUDE_CB], client_name: 'Banco Oficial' });
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: CLAUDE_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'cs',
    });
    const a = await get(`/authorize?${q}`);
    const toWeb = new URL(a.headers.get('location')!);
    expect(`${toWeb.origin}${toWeb.pathname}`).toBe(`${AUTH}/authorize`);
    const id = toWeb.searchParams.get('request')!;

    const anon = await (await get(`/authorize/requests/${id}`)).json() as any;
    expect(anon).toMatchObject({
      id,
      signedIn: false,
      sources: null,
      client: { domain: 'claude.ai', name: 'Claude', verified: true, metadata: 'absent', logoUrl: null, redirectUri: CLAUDE_CB },
    });

    const info = await (await get(`/authorize/requests/${id}`, cookie)).json() as any;
    expect(info.signedIn).toBe(true);
    expect(info.sources).toContainEqual({ source: 'sigaa', status: 'connected' });

    const ap = await send('POST', `/authorize/requests/${id}/approve`, { cookie, body: {} });
    expect(ap.status).toBe(200);
    const redirect = new URL((await ap.json() as any).redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLAUDE_CB);
    expect(redirect.searchParams.get('state')).toBe('cs');

    const tok = await oauth.token({
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code')!,
      client_id: c.clientId,
      redirect_uri: CLAUDE_CB,
      code_verifier: verifier,
    });
    const k = splitToken(tok.access_token).chave!;
    expect(k).toHaveLength(32);
    const opened = await cofre.abrir({ userId: me.id, clientId: c.clientId }, k);
    expect(opened?.senha.reveal()).toBe(SENHA);

    // Apps autorizados: aparece, revoga, some e o token deixa de valer.
    const list = await (await get('/authorized-apps', cookie)).json() as any;
    expect(list.apps).toEqual([
      expect.objectContaining({ clientId: c.clientId, domain: 'claude.ai', name: 'Claude', verified: true, sigaa: true }),
    ]);
    expect((await send('DELETE', `/authorized-apps/${c.clientId}`, { cookie })).status).toBe(204);
    expect((await (await get('/authorized-apps', cookie)).json() as any).apps).toEqual([]);
    expect(await oauth.verifyAccessToken(tok.access_token)).toBeNull();
    expect(await cofre.situacao({ userId: me.id, clientId: c.clientId })).toBeNull();
  });

  it('pedido: 404 inexistente, 410 expirado, aprovar exige sessão; recusar devolve access_denied', async () => {
    expect((await get('/authorize/requests/nao-existe')).status).toBe(404);

    const c = await oauth.registerClient({ redirect_uris: [CLAUDE_CB] });
    const { challenge } = pkce();
    const p = await oauth.begin({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: CLAUDE_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect((await send('POST', `/authorize/requests/${p.id}/approve`, { body: {} })).status).toBe(401);

    const cookie = await signIn('nega');
    const deny = await send('POST', `/authorize/requests/${p.id}/deny`, { cookie, body: {} });
    expect(new URL((await deny.json() as any).redirectTo).searchParams.get('error')).toBe('access_denied');

    const p2 = await oauth.begin({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: CLAUDE_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await store.savePending({ ...p2, expiresAt: Date.now() - 1 });
    const exp = await get(`/authorize/requests/${p2.id}`);
    expect(exp.status).toBe(410);
    expect((await exp.json() as any).error).toBe('request_expired');
  });

  it('pedido inválido no /authorize vai para a página de erro do web, nunca ao cliente', async () => {
    const r = await get('/authorize?client_id=desconhecido&redirect_uri=https://evil.example/cb');
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${AUTH}/authorize/error`);
    expect(loc.searchParams.get('error')).toBe('invalid_client');
  });

  it('documento de metadados: nome saneado, logo servido pela API', async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: META_ID,
      redirect_uri: META_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const a = await get(`/authorize?${q}`);
    const id = new URL(a.headers.get('location')!).searchParams.get('request')!;
    const info = await (await get(`/authorize/requests/${id}`)).json() as any;
    expect(info.client).toMatchObject({ domain: 'app.example', name: 'App Exemplo', verified: false, metadata: 'present' });
    const logo = await get(new URL(info.client.logoUrl).pathname);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await logo.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('dados: /accounts com o cookie lista o SIGAA da sessão', async () => {
    const cookie = await signIn('dados');
    await send('POST', '/connections/sigaa', { cookie, body: { login: 'dados', password: SENHA } });
    const r = await (await get('/accounts', cookie)).json() as any;
    expect(r.accounts).toContainEqual({ source: 'sigaa', account: 'dados', status: 'connected' });
    const bad = await get('/sources/nada/courses', cookie);
    expect(bad.status).toBe(400);
  });

  it('sair apaga a sessão e a senha que só ela abria', async () => {
    const cookie = await signIn('sai');
    await send('POST', '/connections/sigaa', { cookie, body: { login: 'sai', password: SENHA } });
    const me = await (await get('/me', cookie)).json() as any;
    const out = await send('DELETE', '/session', { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await get('/me', cookie)).status).toBe(401);
    expect(await cofre.situacao({ userId: me.id, clientId: WEB_CLIENT_ID })).toBeNull();
  });

  describe('segurança (revisão)', () => {
    async function novoPedido(redirect = CLAUDE_CB, extra: string[] = []) {
      const c = await oauth.registerClient({ redirect_uris: [redirect, ...extra] });
      const { challenge } = pkce();
      const p = await oauth.begin({
        response_type: 'code',
        client_id: c.clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { client: c, id: p.id };
    }

    it('o backend não tem tela: rotas antigas dão 404', async () => {
      for (const path of ['/oauth/connect?txn=x', '/oauth/connect/moodle?txn=x', '/oauth/moodle/capture?u=x', '/oauth/login/google?txn=x']) {
        expect((await get(path)).status).toBe(404);
      }
      const post = await fetch(`${base}/authorize`, { method: 'POST', redirect: 'manual' });
      expect(post.status).toBe(404);
    });

    it('pedido de outra pessoa: aprovar não abre a senha de quem clicou', async () => {
      const vitima = await signIn('vitima');
      await send('POST', '/connections/sigaa', { cookie: vitima, body: { login: 'vitima', password: SENHA } });
      const { id } = await novoPedido();
      const atacante = await (await get('/me', await signIn('atacante'))).json() as any;
      expect(await oauth.claim(id, atacante.id)).toBe(true);

      expect((await get(`/authorize/requests/${id}`, vitima)).status).toBe(404);
      const ap = await send('POST', `/authorize/requests/${id}/approve`, { cookie: vitima, body: {} });
      expect(ap.status).toBe(404);
      expect(cofre.temPendente(id)).toBe(false);
      expect((await send('POST', `/authorize/requests/${id}/deny`, { cookie: vitima, body: {} })).status).toBe(404);
    });

    it('duas aprovações simultâneas do mesmo pedido: só uma emite code', async () => {
      const cookie = await signIn('dupla');
      const { id } = await novoPedido();
      const rs = await Promise.all([
        send('POST', `/authorize/requests/${id}/approve`, { cookie, body: {} }),
        send('POST', `/authorize/requests/${id}/approve`, { cookie, body: {} }),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 404]);
    });

    it('apps autorizados: cliente com redirects em domínios diferentes não herda o selo', async () => {
      const cookie = await signIn('multi');
      const { id, client } = await novoPedido(CLAUDE_CB, ['https://evil.example/cb']);
      const ap = (await (await send('POST', `/authorize/requests/${id}/approve`, { cookie, body: {} })).json()) as any;
      const { verifier } = pkce();
      await oauth.token({
        grant_type: 'authorization_code',
        code: new URL(ap.redirectTo).searchParams.get('code')!,
        client_id: client.clientId,
        redirect_uri: CLAUDE_CB,
        code_verifier: verifier,
      });
      const list = (await (await get('/authorized-apps', cookie)).json()) as any;
      expect(list.apps[0]).toMatchObject({ verified: false, name: null, domain: 'claude.ai, evil.example' });
    });
  });

  describe('vínculo fixo conta ↔ titular na fonte', () => {
    const CPF_A = '123.456.789-09';
    const CPF_B = '987.654.321-00';
    const sigaaPost = (cookie: string, login: string) =>
      send('POST', '/connections/sigaa', { cookie, body: { login, password: SENHA } });

    it('SIGAA: liga no 1º CPF; o mesmo CPF (com ou sem máscara) reconecta; outro CPF é recusado antes de falar com o SIGAA', async () => {
      const cookie = await signIn('vinc1');
      expect((await sigaaPost(cookie, CPF_A)).status).toBe(204);
      expect((await sigaaPost(cookie, '12345678909')).status).toBe(204);

      const antes = sigaaValidations.length;
      const r = await sigaaPost(cookie, CPF_B);
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_account_mismatch');
      expect(sigaaValidations.length).toBe(antes); // nem tocou o SIGAA

      // Desconectar apaga a senha, mas o vínculo fica.
      expect((await send('DELETE', '/connections/sigaa', { cookie })).status).toBe(204);
      expect((await sigaaPost(cookie, CPF_B)).status).toBe(409);
      expect((await sigaaPost(cookie, CPF_A)).status).toBe(204);
    });

    it('SIGAA: CPF de outra conta é recusado só depois da senha certa (senha errada não revela nada)', async () => {
      await sigaaPost(await signIn('dono-cpf'), '111.222.333-44');
      const intruso = await signIn('intruso');
      const errada = await send('POST', '/connections/sigaa', { cookie: intruso, body: { login: '11122233344', password: 'x' } });
      expect(errada.status).toBe(422);
      const r = await sigaaPost(intruso, '11122233344');
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_account_taken');
      expect(((await (await get('/me', intruso)).json()) as any).connections.sigaa.status).toBe('disconnected');
    });

    it('Moodle: só a conta institucional (Shibboleth) com o mesmo usuário do e-mail de login', async () => {
      const cookie = await signIn('aluna');
      const post = () => send('POST', '/connections/moodle', { cookie, body: { link: 'web+ufba://token=x' } });

      moodleAccount = { ...moodleAccount, moodleUserId: 50, username: 'outra.pessoa', auth: 'shibboleth' };
      let r = await post();
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).error).toBe('source_account_not_owned');

      moodleAccount = { ...moodleAccount, username: 'aluna', auth: 'manual' };
      expect((await post()).status).toBe(403);

      moodleAccount = { ...moodleAccount, auth: 'shibboleth' };
      expect((await post()).status).toBe(204);
      const me = (await (await get('/me', cookie)).json()) as any;
      expect(me.connections.moodle).toEqual({ status: 'connected', account: 'ava.ufba.br:aluna' });

      // Mesmo usuário com outro id no AVA (conta recriada): esta conta do ufba.app já está ligada ao id anterior.
      moodleAccount = { ...moodleAccount, moodleUserId: 51 };
      r = await post();
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_account_mismatch');
    });

    it('excluir a conta apaga tudo e libera os vínculos: ao entrar de novo, pode ligar outro CPF', async () => {
      let cookie = await signIn('recomeco');
      expect((await sigaaPost(cookie, CPF_A.replace('123', '555'))).status).toBe(204);
      expect((await sigaaPost(cookie, CPF_B)).status).toBe(409);

      const del = await send('DELETE', '/me', { cookie });
      expect(del.status).toBe(204);
      expect(del.headers.get('set-cookie')).toMatch(/Max-Age=0/);
      expect((await get('/me', cookie)).status).toBe(401);

      cookie = await signIn('recomeco');
      expect((await sigaaPost(cookie, CPF_B)).status).toBe(204);
    });

    it('excluir a conta exige sessão e CSRF', async () => {
      const cookie = await signIn('cuidado');
      expect((await send('DELETE', '/me', { cookie, csrf: false })).status).toBe(403);
      expect((await send('DELETE', '/me')).status).toBe(401);
      expect((await get('/me', cookie)).status).toBe(200);
    });
  });

  // Fica por último: confere a saída da suíte inteira.
  it('canário: a senha nunca aparece em log, erro ou resposta (inclusive JSON malformado com a senha)', async () => {
    const cookie = await signIn();
    const respostas: string[] = [];
    for (const path of ['/connections/sigaa', '/session']) {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: WEB, cookie },
        body: `{"login":"a","password":"${SENHA}"`,
      });
      respostas.push(await r.text());
    }
    const errada = await send('POST', '/connections/sigaa', { cookie, body: { login: 'a', password: `${SENHA}-x` } });
    respostas.push(await errada.text());

    expect(respostas.join('\n')).not.toContain(SENHA);
    expect(saida.join('\n')).not.toContain(SENHA);
  });
});
