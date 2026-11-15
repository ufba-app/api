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
  SigaaMasterSlotRepository,
  SigaaPairingRepository,
  SigaaVaultRepository,
  SourceAccountRecord,
  SourceBindingRepository,
  SourceAccountRepository,
  UserRepository,
} from '../src/application/ports/repositories';
import { CofreSigaa } from '../src/application/sigaa/cofre-sigaa';
import { SiasbError, SiasbSession, SiasbSource, type SiasbCourse } from '../src/application/ports/siasb-source';
import { StudentRegistrations } from '../src/application/ports/repositories';
import { MemoryProjectRepository } from '../src/application/memory/project-ports';
import { WEB_CLIENT_ID } from '../src/application/web/web-api';
import { InMemoryProjectRepo } from './support/memory-fakes';
import { InMemorySlots } from './support/slot-fake';
import { UserPermissionRepository } from '../src/application/ports/permissions';
import { InMemoryPermissions } from './support/permission-fake';
import { AcademicRepository, TranscriptSource } from '../src/application/ports/academic';
import { CatalogRepository, CatalogSource } from '../src/application/ports/catalog';
import { PdfTextExtractor, TRANSCRIPT_READER } from '../src/application/ports/transcript';
import { FakeCatalogSource, InMemoryCatalog } from './support/catalog-fake';
import { FakeExtractor, FakeReader, FakeTranscriptSource, InMemoryAcademic, curriculumOf, perfectTranscript } from './support/academic-fake';
import { InMemoryCredentials, InMemoryVaults } from './support/sigaa-store-fake';
import { InMemoryPairings } from './support/pairing-fake';
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
const SENHA_SIASB = 'senha-canario-siasb-123';
const MATRICULA = '012345678';

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
  const credsRepo = new InMemoryCredentials();
  const vaultsRepo = new InMemoryVaults();
  const accounts: SourceAccountRecord[] = [];
  const slotsRepo = new InMemorySlots();
  const pairingsRepo = new InMemoryPairings();
  const permissionsRepo = new InMemoryPermissions();
  // Vida acadêmica: tudo falso (sem rede, sem SIGAA, sem IA).
  const academicRepo = new InMemoryAcademic();
  const academicSource = new FakeTranscriptSource();
  const academicReader = new FakeReader();
  const academicExtractor = new FakeExtractor();
  const catalogRepo = new InMemoryCatalog();
  const catalogSource = new FakeCatalogSource();
  const sigaaValidations: string[] = [];
  // SIASB falso: matrícula por pessoa e o que o "SIASB" responde (cada teste ajusta).
  const registrations = new Map<string, string>();
  const siasbCourses: SiasbCourse[] = [{ id: 7, name: 'Odontologia', abbreviation: 'ODO', isDefault: true }];
  const siasbState: { failure: SiasbError | null; username: string; expiresAt: Date | null; courseCalls: number } = {
    failure: null,
    username: MATRICULA,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    courseCalls: 0,
  };
  const siasbSource = new (class extends SiasbSource {
    async courseOptions() {
      siasbState.courseCalls++;
      if (siasbState.failure) throw siasbState.failure;
      return siasbCourses;
    }
    async login() {
      if (siasbState.failure) throw siasbState.failure;
      return { session: new SiasbSession({ k: 'v' }, siasbState.expiresAt), username: siasbState.username };
    }
    disciplines = async () => [];
    attendances = async () => [];
    sessions = async () => [];
    procedures = async () => [];
    unassignedCount = async () => ({});
  })();
  // Exclusão de conta: o banco apaga em cascata; aqui, o diretório falso apaga os vínculos e contas da pessoa.
  const users = new (class extends MemoryUserDirectory {
    override async deleteAccount(userId: string): Promise<void> {
      await super.deleteAccount(userId);
      for (let i = bindingRows.length - 1; i >= 0; i--) if (bindingRows[i].userId === userId) bindingRows.splice(i, 1);
      for (let i = accounts.length - 1; i >= 0; i--) if (accounts[i].userId === userId) accounts.splice(i, 1);
      await credsRepo.deleteAllOf(userId);
      await vaultsRepo.delete(userId);
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
      .overrideProvider(SiasbSource)
      .useValue(siasbSource)
      .overrideProvider(StudentRegistrations)
      .useValue({ find: async (u: string) => registrations.get(u) ?? null })
      .overrideProvider(MemoryProjectRepository)
      .useValue(new InMemoryProjectRepo())
      .overrideProvider(UserRepository)
      .useValue({})
      .overrideProvider(ApiKeyRepository)
      .useValue({ findActiveByHash: async () => null })
      .overrideProvider(SourceBindingRepository)
      .useValue(bindings)
      .overrideProvider(SigaaMasterSlotRepository)
      .useValue(slotsRepo)
      .overrideProvider(SigaaPairingRepository)
      .useValue(pairingsRepo)
      .overrideProvider(UserPermissionRepository)
      .useValue(permissionsRepo)
      .overrideProvider(AcademicRepository)
      .useValue(academicRepo)
      .overrideProvider(TranscriptSource)
      .useValue(academicSource)
      .overrideProvider(PdfTextExtractor)
      .useValue(academicExtractor)
      .overrideProvider(TRANSCRIPT_READER)
      .useValue(academicReader)
      .overrideProvider(CatalogRepository)
      .useValue(catalogRepo)
      .overrideProvider(CatalogSource)
      .useValue(catalogSource)
      .overrideProvider(SigaaCredentialRepository)
      .useValue(credsRepo)
      .overrideProvider(SigaaVaultRepository)
      .useValue(vaultsRepo)
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
            expiresAt: i.expiresAt ?? null,
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
    expect(me.connections.sigaa).toEqual({ status: 'disconnected', login: null, passkey: { slots: 0 } });
    expect(me.connections.moodle.status).toBe('disconnected');
    expect(me.connections.siasb).toEqual({ offered: false, status: 'disconnected', expiresAt: null });
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
    expect(me.connections.sigaa).toEqual({ status: 'connected', login: 'aluno', passkey: { slots: 0 } });

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
    // A cópia da DK é por sessão: sair apaga a desta sessão e nenhuma sobra para a pessoa.
    expect([...credsRepo.rows.values()].filter((r) => r.userId === me.id)).toHaveLength(0);
  });

  describe('chave mestra do SIGAA (passkey)', () => {
    const CT = 'CANARIOcifradoNoNavegador0123456789_-abcdefghij';
    const SAL = 'S'.repeat(43);
    const dksVistas: string[] = [];
    const slot = (n: number, extra: Record<string, unknown> = {}) => ({
      credentialId: `cred${n}-` + 'x'.repeat(16),
      prfSalt: SAL,
      iv: 'I'.repeat(16),
      ciphertext: CT,
      label: `iPhone ${n}`,
      ...extra,
    });
    async function conectado(who: string) {
      const cookie = await signIn(who);
      expect((await send('POST', '/connections/sigaa', { cookie, body: { login: who, password: SENHA } })).status).toBe(204);
      return cookie;
    }

    it('guardar, listar, sair e entrar: o SIGAA volta como "locked" e um toque o religa', async () => {
      const cookie = await conectado('mestra1');
      expect((await send('POST', '/sigaa/passkey', { cookie, body: slot(1) })).status).toBe(204);

      const lista = (await (await get('/sigaa/passkey', cookie)).json()) as any;
      expect(lista.passkeys).toHaveLength(1);
      expect(lista.passkeys[0]).toMatchObject({ credentialId: slot(1).credentialId, prfSalt: SAL, label: 'iPhone 1', lastUnlockedAt: null });
      expect(lista.passkeys[0].ciphertext).toBeUndefined();
      const me = (await (await get('/me', cookie)).json()) as any;
      expect(me.connections.sigaa).toEqual({ status: 'connected', login: 'mestra1', passkey: { slots: 1 } });

      // Ao ativar, o navegador pediu a DK (e a cifrou com a passkey; aqui só guardamos para devolver no desbloqueio).
      const chave = await send('GET', '/connections/sigaa/key', { cookie });
      expect(chave.status).toBe(200);
      expect(chave.headers.get('cache-control')).toBe('no-store');
      const { dk } = (await chave.json()) as any;
      expect(dk).toMatch(/^[A-Za-z0-9_-]{43}$/);
      dksVistas.push(dk);

      // Sair apaga a cópia da DK da sessão; o cofre e a cópia da passkey ficam.
      expect((await send('DELETE', '/session', { cookie })).status).toBe(204);
      const nova = await signIn('mestra1');
      const me2 = (await (await get('/me', nova)).json()) as any;
      expect(me2.connections.sigaa).toEqual({ status: 'locked', login: 'mestra1', passkey: { slots: 1 } });

      // O navegador pede a cópia (id no corpo), abre com a passkey e desbloqueia com a DK: sem digitar a senha.
      const s = await send('POST', '/sigaa/passkey/slot', { cookie: nova, body: { credentialId: slot(1).credentialId } });
      expect(s.status).toBe(200);
      expect(await s.json()).toEqual({ prfSalt: SAL, iv: slot(1).iv, ciphertext: CT });
      expect((await send('POST', '/connections/sigaa/unlock', { cookie: nova, body: { dk } })).status).toBe(204);
      const me3 = (await (await get('/me', nova)).json()) as any;
      expect(me3.connections.sigaa.status).toBe('connected');
      const l2 = (await (await get('/sigaa/passkey', nova)).json()) as any;
      expect(l2.passkeys[0].lastUnlockedAt).not.toBeNull();
    });

    it('outra sessão com a senha guardada mas sem a K também fica "locked"', async () => {
      const cookie = await conectado('mestra2');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      const outra = await signIn('mestra2');
      expect(((await (await get('/me', outra)).json()) as any).connections.sigaa).toMatchObject({ status: 'locked', login: 'mestra2' });
    });

    it('só guarda com o SIGAA conectado nesta sessão', async () => {
      const cookie = await signIn('mestra3');
      const r = await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_not_connected');
    });

    it('limite de 5 por pessoa (409); passam de 5 gravações por hora, 429', async () => {
      const cookie = await conectado('mestra4');
      for (let i = 1; i <= 5; i++) expect((await send('POST', '/sigaa/passkey', { cookie, body: slot(i) })).status).toBe(204);
      const sexta = await send('POST', '/sigaa/passkey', { cookie, body: slot(6) });
      expect(sexta.status).toBe(409);
      expect(((await sexta.json()) as any).error).toBe('passkey_limit_reached');
      // Regravar uma passkey que já existe não conta no limite de cópias, mas conta nas 5 gravações por hora.
      expect((await send('POST', '/sigaa/passkey', { cookie, body: slot(3) })).status).toBe(429);
      expect(((await (await get('/sigaa/passkey', cookie)).json()) as any).passkeys).toHaveLength(5);
    });

    it('remover: 204, depois 404 passkey_not_found; id inválido é 400; cópia de outra pessoa não existe', async () => {
      const cookie = await conectado('mestra5');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      const outro = await signIn('mestra5-outro');
      const alheia = await send('POST', '/sigaa/passkey/slot', { cookie: outro, body: { credentialId: slot(1).credentialId } });
      expect(alheia.status).toBe(404);
      expect((await send('DELETE', `/sigaa/passkey/${slot(1).credentialId}`, { cookie: outro })).status).toBe(404);

      expect((await send('DELETE', `/sigaa/passkey/${slot(1).credentialId}`, { cookie })).status).toBe(204);
      const denovo = await send('DELETE', `/sigaa/passkey/${slot(1).credentialId}`, { cookie });
      expect(denovo.status).toBe(404);
      expect(((await denovo.json()) as any).error).toBe('passkey_not_found');
      expect((await send('DELETE', '/sigaa/passkey/id%20ruim', { cookie })).status).toBe(400);
      expect(((await (await get('/me', cookie)).json()) as any).connections.sigaa.passkey.slots).toBe(0);
    });

    it('desconectar o SIGAA apaga as cópias mestras', async () => {
      const cookie = await conectado('mestra6');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      expect((await send('DELETE', '/connections/sigaa', { cookie })).status).toBe(204);
      const me = (await (await get('/me', cookie)).json()) as any;
      expect(me.connections.sigaa).toEqual({ status: 'disconnected', login: null, passkey: { slots: 0 } });
    });

    it('senha errada digitada NÃO apaga as passkeys (elas guardam a DK, não a senha)', async () => {
      const cookie = await conectado('mestra8');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      await send('DELETE', '/session', { cookie });
      const nova = await signIn('mestra8');
      expect(((await (await get('/me', nova)).json()) as any).connections.sigaa.status).toBe('locked');

      const recusada = await send('POST', '/connections/sigaa', { cookie: nova, body: { login: 'mestra8', password: `${SENHA}-velha` } });
      expect(recusada.status).toBe(422);
      const me = (await (await get('/me', nova)).json()) as any;
      expect(me.connections.sigaa).toEqual({ status: 'locked', login: 'mestra8', passkey: { slots: 1 } });
    });

    it('trocar a senha COM a DK da sessão mantém as passkeys; digitá-la sem a DK cria DK nova e as apaga', async () => {
      const cookie = await conectado('mestra11');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      // Sessão que tem a DK: digitar a senha de novo recifra só o cofre.
      expect((await send('POST', '/connections/sigaa', { cookie, body: { login: 'mestra11', password: SENHA } })).status).toBe(204);
      expect(((await (await get('/me', cookie)).json()) as any).connections.sigaa.passkey.slots).toBe(1);

      // Sessão sem a DK (a pessoa digitou em vez de desbloquear): DK nova, e as passkeys (que guardam a velha) morrem.
      await send('DELETE', '/session', { cookie });
      const nova = await signIn('mestra11');
      expect((await send('POST', '/connections/sigaa', { cookie: nova, body: { login: 'mestra11', password: SENHA } })).status).toBe(204);
      const me = (await (await get('/me', nova)).json()) as any;
      expect(me.connections.sigaa).toEqual({ status: 'connected', login: 'mestra11', passkey: { slots: 0 } });
    });

    it('a chave do cofre só sai com o SIGAA aberto nesta sessão; desbloquear com DK errada ou sem cofre falha', async () => {
      const cookie = await conectado('mestra12');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      await send('DELETE', '/session', { cookie });
      const nova = await signIn('mestra12');

      const semAbrir = await send('GET', '/connections/sigaa/key', { cookie: nova }); // locked: esta sessão não abre
      expect(semAbrir.status).toBe(409);
      expect(((await semAbrir.json()) as any).error).toBe('source_not_connected');
      expect((await send('GET', '/connections/sigaa/key')).status).toBe(401);
      // Sem X-UFBA (um <img> de outro subdomínio, por exemplo): recusado antes de gastar o limite.
      const semHeader = await get('/connections/sigaa/key', nova);
      expect(semHeader.status).toBe(403);
      expect(((await semHeader.json()) as any).error).toBe('csrf_rejected');

      const errada = await send('POST', '/connections/sigaa/unlock', { cookie: nova, body: { dk: 'D'.repeat(43) } });
      expect(errada.status).toBe(422);
      expect(((await errada.json()) as any).error).toBe('invalid_credentials');
      expect((await send('POST', '/connections/sigaa/unlock', { cookie: nova, body: { dk: 'curto' } })).status).toBe(400);
      expect((await send('POST', '/connections/sigaa/unlock', { cookie: nova, body: { dk: 'D'.repeat(43) }, csrf: false })).status).toBe(403);

      const semCofre = await signIn('mestra12-sem-cofre');
      const r = await send('POST', '/connections/sigaa/unlock', { cookie: semCofre, body: { dk: 'D'.repeat(43) } });
      expect(r.status).toBe(409);
    });

    it('as respostas com a cópia cifrada vão com Cache-Control: no-store', async () => {
      const cookie = await conectado('mestra9');
      await send('POST', '/sigaa/passkey', { cookie, body: slot(1) });
      expect((await get('/sigaa/passkey', cookie)).headers.get('cache-control')).toBe('no-store');
      const s = await send('POST', '/sigaa/passkey/slot', { cookie, body: { credentialId: slot(1).credentialId } });
      expect(s.headers.get('cache-control')).toBe('no-store');
    });

    it('duas gravações juntas não furam o limite de 5 cópias', async () => {
      const cookie = await conectado('mestra10');
      for (let i = 1; i <= 4; i++) await send('POST', '/sigaa/passkey', { cookie, body: slot(i) });
      const [a, b] = await Promise.all([
        send('POST', '/sigaa/passkey', { cookie, body: slot(5) }),
        send('POST', '/sigaa/passkey', { cookie, body: slot(6) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([204, 409]);
      expect(((await (await get('/sigaa/passkey', cookie)).json()) as any).passkeys).toHaveLength(5);
    });

    it('uma cópia da DK por sessão do painel: desbloquear num aparelho não tranca o outro, e Sair num não tranca os demais', async () => {
      const a = await conectado('multi1');
      await send('POST', '/sigaa/passkey', { cookie: a, body: slot(1) });
      const { dk } = (await (await send('GET', '/connections/sigaa/key', { cookie: a })).json()) as any;

      // Segundo aparelho: a sessão dele ainda não abre (locked) e desbloqueia com a DK (QR ou passkey).
      const b = await signIn('multi1');
      expect(((await (await get('/me', b)).json()) as any).connections.sigaa.status).toBe('locked');
      expect((await send('POST', '/connections/sigaa/unlock', { cookie: b, body: { dk } })).status).toBe(204);

      // Os dois ficam abertos AO MESMO TEMPO (antes, um sobrescrevia a cópia do outro).
      const meA = (await (await get('/me', a)).json()) as any;
      const meB = (await (await get('/me', b)).json()) as any;
      expect(meA.connections.sigaa.status).toBe('connected');
      expect(meB.connections.sigaa.status).toBe('connected');
      expect([...credsRepo.rows.values()].filter((r) => r.userId === meA.id && r.clientId.startsWith('ufba-web:'))).toHaveLength(2);

      // Sair no aparelho A não tranca o B; uma sessão nova continua pedindo a passkey.
      expect((await send('DELETE', '/session', { cookie: a })).status).toBe(204);
      expect(((await (await get('/me', b)).json()) as any).connections.sigaa.status).toBe('connected');
      const c = await signIn('multi1');
      expect(((await (await get('/me', c)).json()) as any).connections.sigaa.status).toBe('locked');
      expect([...credsRepo.rows.values()].filter((r) => r.userId === meA.id && r.clientId.startsWith('ufba-web:'))).toHaveLength(1);
    });

    it('as leituras ao vivo do painel usam a cópia da própria sessão', async () => {
      const cookie = await conectado('multi2');
      const r = (await (await get('/accounts', cookie)).json()) as any;
      expect(r.accounts).toContainEqual({ source: 'sigaa', account: 'multi2', status: 'connected' });
    });

    it('entrada inválida: sal, iv, id e rótulo fora do formato dão 400 sem ecoar o valor; exige sessão e CSRF', async () => {
      const cookie = await conectado('mestra7');
      for (const ruim of [
        slot(1, { prfSalt: 'curto' }),
        slot(1, { iv: 'I'.repeat(15) }),
        slot(1, { credentialId: 'tem espaço' }),
        slot(1, { ciphertext: 'a+b/c=' }),
        slot(1, { label: 'x'.repeat(41) }),
      ]) {
        const r = await send('POST', '/sigaa/passkey', { cookie, body: ruim });
        expect(r.status).toBe(400);
        expect(await r.text()).not.toContain('espaço');
      }
      expect((await send('POST', '/sigaa/passkey', { body: slot(1) })).status).toBe(401);
      expect((await send('POST', '/sigaa/passkey', { cookie, body: slot(1), csrf: false })).status).toBe(403);
      expect((await get('/sigaa/passkey')).status).toBe(401);
    });

    it('o texto cifrado, o sal e a DK nunca aparecem em log ou erro', async () => {
      expect(saida.join('\n')).not.toContain(CT);
      expect(saida.join('\n')).not.toContain(SAL);
      for (const d of dksVistas) expect(saida.join('\n')).not.toContain(d);
    });
  });

  describe('liberação por QR (correio entre computador e celular)', () => {
    const PUB = 'CANARIOpub' + 'P'.repeat(77); // 87 caracteres = 65 bytes
    const IV = 'CANARIOiv0123456'; // 16 caracteres = 12 bytes
    const CT = 'CANARIOpacoteLacrado0123456789abcdefghij';
    const pacote = { pub: PUB, iv: IV, ciphertext: CT };
    const novo = async (cookie: string, body: Record<string, unknown> = { label: 'Firefox no Windows', client: 'Claude' }) => {
      const r = await send('POST', '/pairings', { cookie, body });
      expect(r.status).toBe(201);
      return (await r.json()) as any;
    };

    it('fluxo completo: o computador cria, o celular da mesma conta vê e entrega, o computador lê uma vez só', async () => {
      const pc = await signIn('par1');
      const celular = await signIn('par1'); // mesma conta, outra sessão
      const criado = await novo(pc);
      expect(criado.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(new Date(criado.expiresAt).getTime()).toBeGreaterThan(Date.now());

      expect(await (await get(`/pairings/${criado.id}`, pc)).json()).toEqual({ status: 'pending' });

      const info = (await (await get(`/pairings/${criado.id}/info`, celular)).json()) as any;
      expect(info).toMatchObject({ label: 'Firefox no Windows', client: 'Claude', delivered: false });

      expect((await send('POST', `/pairings/${criado.id}`, { cookie: celular, body: pacote })).status).toBe(204);
      const segunda = await send('POST', `/pairings/${criado.id}`, { cookie: celular, body: pacote });
      expect(segunda.status).toBe(409);
      expect(((await segunda.json()) as any).error).toBe('pairing_already_delivered');

      const lido = await get(`/pairings/${criado.id}`, pc);
      expect(lido.headers.get('cache-control')).toBe('no-store');
      expect(await lido.json()).toEqual({ status: 'delivered', ...pacote });
      const depois = await get(`/pairings/${criado.id}`, pc);
      expect(depois.status).toBe(404);
      expect(((await depois.json()) as any).error).toBe('pairing_not_found');
    });

    it('o celular recebe o que a API VIU (User-Agent), não o que o computador escreveu (QR de golpe)', async () => {
      const pc = await signIn('par6');
      const celular = await signIn('par6');
      // O computador (ou quem mostra um QR de golpe) escreve no corpo o que quiser...
      const criado = await fetch(`${base}/pairings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ufba': '1',
          origin: WEB,
          cookie: pc,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0',
        },
        body: JSON.stringify({ label: 'iPhone da sua mãe, no Banco do Brasil', client: 'Banco do Brasil' }),
      });
      expect(criado.status).toBe(201);
      const { id } = (await criado.json()) as any;

      // ...mas a API grava o que ela mesma viu e devolve isso no info, junto do que o computador "diz".
      const info = (await (await get(`/pairings/${id}/info`, celular)).json()) as any;
      expect(info).toMatchObject({ seenBrowser: 'Firefox 160', seenOs: 'Windows' });
      expect(info.label).toBe('iPhone da sua mãe, no Banco do Brasil'); // continua ali, como "o computador diz"
      expect(info.createdAt).toBeTruthy();
    });

    it('sem User-Agent reconhecível, seenBrowser e seenOs vêm nulos (a tela mostra só o horário)', async () => {
      const cookie = await signIn('par7');
      const criado = await fetch(`${base}/pairings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: WEB, cookie, 'user-agent': 'curl/8.5.0' },
        body: '{}',
      });
      const { id } = (await criado.json()) as any;
      const info = (await (await get(`/pairings/${id}/info`, cookie)).json()) as any;
      expect(info).toMatchObject({ seenBrowser: null, seenOs: null });
    });

    it('outra conta não vê, não entrega e não lê (responde como "não encontrado")', async () => {
      const dono = await signIn('par2');
      const intruso = await signIn('par2-intruso');
      const criado = await novo(dono);
      for (const r of [
        await get(`/pairings/${criado.id}/info`, intruso),
        await send('POST', `/pairings/${criado.id}`, { cookie: intruso, body: pacote }),
        await get(`/pairings/${criado.id}`, intruso),
      ]) {
        expect(r.status).toBe(404);
        expect(((await r.json()) as any).error).toBe('pairing_not_found');
      }
      // O pedido do dono segue intacto.
      expect(await (await get(`/pairings/${criado.id}`, dono)).json()).toEqual({ status: 'pending' });
    });

    it('pedido vencido some para todos', async () => {
      const cookie = await signIn('par3');
      const criado = await novo(cookie);
      pairingsRepo.rows.get(criado.id)!.expiresAt = new Date(Date.now() - 1000);
      expect((await get(`/pairings/${criado.id}/info`, cookie)).status).toBe(404);
      expect((await send('POST', `/pairings/${criado.id}`, { cookie, body: pacote })).status).toBe(404);
      expect((await get(`/pairings/${criado.id}`, cookie)).status).toBe(404);
    });

    it('no máximo 3 pedidos abertos por pessoa (429)', async () => {
      const cookie = await signIn('par4');
      for (let i = 0; i < 3; i++) await novo(cookie);
      const quarto = await send('POST', '/pairings', { cookie, body: {} });
      expect(quarto.status).toBe(429);
      expect(((await quarto.json()) as any).error).toBe('too_many_attempts');
    });

    it('entrada inválida dá 400 sem ecoar o valor; exige sessão e CSRF', async () => {
      const cookie = await signIn('par5');
      const criado = await novo(cookie, {});
      expect((await get('/pairings/curto', cookie)).status).toBe(400);
      expect((await get('/pairings/curto/info', cookie)).status).toBe(400);
      for (const ruim of [{ ...pacote, pub: 'curto' }, { ...pacote, iv: 'I'.repeat(15) }, { ...pacote, ciphertext: 'a+b/c=' }, {}]) {
        const r = await send('POST', `/pairings/${criado.id}`, { cookie, body: ruim });
        expect(r.status).toBe(400);
        expect(await r.text()).not.toContain('a+b/c=');
      }
      expect((await send('POST', '/pairings', { cookie, body: { label: 'x'.repeat(61) } })).status).toBe(400);
      expect((await send('POST', '/pairings', { body: {} })).status).toBe(401);
      expect((await send('POST', '/pairings', { cookie, body: {}, csrf: false })).status).toBe(403);
      expect((await get(`/pairings/${criado.id}`)).status).toBe(401);
    });

    it('o pacote lacrado nunca aparece em log ou erro', async () => {
      for (const s of [PUB, IV, CT]) expect(saida.join('\n')).not.toContain(s);
    });
  });

  describe('permissões por fonte', () => {
    it('lista as permissões com texto da API, todas DESLIGADAS e indisponíveis sem a fonte conectada', async () => {
      const cookie = await signIn('perm1');
      const r = await get('/me/permissions', cookie);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const { items } = (await r.json()) as { items: any[] };
      expect(items.map((i) => i.key)).toEqual(['siasb.schedule_write', 'siasb.procedures_write']);
      expect(items[0]).toMatchObject({
        source: 'siasb',
        title: 'Agendar e desmarcar sessões pelo Claude',
        risk: 'low',
        enabled: false,
        available: false,
        unavailableReason: 'source_not_connected',
      });
      expect(items[0].description).toMatch(/pede a sua confirmação/);
      expect(items[1]).toMatchObject({ risk: 'high', enabled: false });
    });

    it('ligar sem a fonte conectada: 409 permission_unavailable, e nada é gravado', async () => {
      const cookie = await signIn('perm2');
      const r = await send('PUT', '/me/permissions/siasb.schedule_write', { cookie, body: { enabled: true } });
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('permission_unavailable');
      expect(permissionsRepo.rows.size).toBe(0);
    });

    it('desligar é sempre permitido (204), mesmo sem a fonte', async () => {
      const cookie = await signIn('perm3');
      expect((await send('PUT', '/me/permissions/siasb.procedures_write', { cookie, body: { enabled: false } })).status).toBe(204);
    });

    it('chave desconhecida e corpo inválido: 400 invalid_request', async () => {
      const cookie = await signIn('perm4');
      const a = await send('PUT', '/me/permissions/siasb.nao_existe', { cookie, body: { enabled: true } });
      expect(a.status).toBe(400);
      expect(((await a.json()) as any).error).toBe('invalid_request');
      expect((await send('PUT', '/me/permissions/siasb.schedule_write', { cookie, body: { enabled: 'sim' } })).status).toBe(400);
    });

    it('exige sessão, X-UFBA e Origin da casa', async () => {
      const cookie = await signIn('perm5');
      expect((await get('/me/permissions')).status).toBe(401);
      expect((await send('PUT', '/me/permissions/siasb.schedule_write', { body: { enabled: false } })).status).toBe(401);
      expect((await send('PUT', '/me/permissions/siasb.schedule_write', { cookie, body: { enabled: false }, csrf: false })).status).toBe(403);
    });
  });

  describe('vida acadêmica (histórico lido pela IA e adequado ao currículo Ativo)', () => {
    beforeAll(() => {
      catalogSource.programs = [{ sigaaId: '10', name: 'ENGENHARIA DA COMPUTAÇÃO', campus: 'SALVADOR', level: 'G' }];
      catalogSource.components = curriculumOf(perfectTranscript());
    });

    async function conectado(who: string) {
      const cookie = await signIn(who);
      expect((await send('POST', '/connections/sigaa', { cookie, body: { login: who, password: SENHA } })).status).toBe(204);
      return cookie;
    }

    async function esperar(cookie: string, status: string) {
      for (let i = 0; i < 100; i++) {
        const s = (await (await get('/me/academic', cookie)).json()) as any;
        if (s.status === status) return s;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`a importação não chegou a ${status}`);
    }

    it('fluxo completo: consentir, importar em segundo plano, confirmar, ver a grade do curso e apagar', async () => {
      const cookie = await conectado('acad1');
      const inicial = (await (await get('/me/academic', cookie)).json()) as any;
      expect(inicial).toMatchObject({ available: true, consent: false, status: 'NONE', summary: null, draft: null, curriculumStatus: 'NONE' });

      // Sem consentimento, não importa.
      const semAceite = await send('POST', '/me/academic/import', { cookie, body: {} });
      expect(semAceite.status).toBe(409);
      expect(((await semAceite.json()) as any).error).toBe('consent_required');

      expect((await send('PUT', '/me/academic/consent', { cookie, body: { accepted: true } })).status).toBe(204);
      expect(((await (await get('/me/academic', cookie)).json()) as any).consent).toBe(true);

      // Importa: 202 na hora; a leitura roda em segundo plano.
      expect((await send('POST', '/me/academic/import', { cookie, body: {} })).status).toBe(202);
      const lido = await esperar(cookie, 'NEEDS_CONFIRMATION');
      expect(lido).toMatchObject({ verified: true, reader: 'ai', failure: null, curriculumStatus: 'READY', summary: null });
      expect(lido.draft.components).toHaveLength(49);
      expect(lido.draft.verification).toMatchObject({ verified: true, reader: 'ai' });
      expect(JSON.stringify(lido)).not.toMatch(/docente|instructor|senha/i);

      // Antes de confirmar, nada de grade nem de histórico gravado.
      expect((await get('/me/academic/curriculum', cookie)).status).toBe(404);

      expect((await send('POST', '/me/academic/confirm', { cookie, body: {} })).status).toBe(204);
      const pronto = (await (await get('/me/academic', cookie)).json()) as any;
      expect(pronto).toMatchObject({ status: 'READY', draft: null, curriculumStatus: 'READY' });
      expect(pronto.importedAt).toBeTruthy();
      expect(pronto.summary).toMatchObject({ currentTerm: expect.any(Number), indices: { cr: expect.any(Number) } });

      const grade = await get('/me/academic/curriculum', cookie);
      expect(grade.status).toBe(200);
      expect(grade.headers.get('cache-control')).toBe('no-store');
      const g = (await grade.json()) as any;
      expect(g).toMatchObject({ estimate: true, curriculumCode: 'G20251' });
      expect(g.required.find((c: any) => c.code === 'FISD36').state).toBe('DONE');
      expect(Object.keys(g.hours)).toEqual(['required', 'elective', 'complementary', 'total']);

      expect((await send('DELETE', '/me/academic', { cookie })).status).toBe(204);
      expect(((await (await get('/me/academic', cookie)).json()) as any)).toMatchObject({ status: 'NONE', consent: true, summary: null });
    });

    it('SIGAA fechado nesta sessão: 409 source_not_connected', async () => {
      const cookie = await signIn('acad2'); // sem conectar o SIGAA
      await send('PUT', '/me/academic/consent', { cookie, body: { accepted: true } });
      const r = await send('POST', '/me/academic/import', { cookie, body: {} });
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_not_connected');
    });

    it('falha da fonte vira estado FAILED com o código (sem a mensagem do erro) e dá para tentar de novo', async () => {
      const cookie = await conectado('acad3');
      await send('PUT', '/me/academic/consent', { cookie, body: { accepted: true } });
      academicReader.fail = true;
      await send('POST', '/me/academic/import', { cookie, body: {} });
      const falhou = await esperar(cookie, 'FAILED');
      expect(falhou).toMatchObject({ failure: 'READER_FAILED', draft: null });
      expect(JSON.stringify(falhou)).not.toContain('sem crédito');
      academicReader.fail = false;
      expect((await send('POST', '/me/academic/import', { cookie, body: {} })).status).toBe(202);
      await esperar(cookie, 'NEEDS_CONFIRMATION');
    });

    it('confirmar sem rascunho: 404 import_not_found', async () => {
      const cookie = await signIn('acad4');
      const r = await send('POST', '/me/academic/confirm', { cookie, body: {} });
      expect(r.status).toBe(404);
      expect(((await r.json()) as any).error).toBe('import_not_found');
    });

    it('exige sessão e CSRF; corpo inválido no consentimento dá 400', async () => {
      const cookie = await signIn('acad5');
      expect((await get('/me/academic')).status).toBe(401);
      expect((await send('PUT', '/me/academic/consent', { body: { accepted: true } })).status).toBe(401);
      expect((await send('PUT', '/me/academic/consent', { cookie, body: { accepted: true }, csrf: false })).status).toBe(403);
      expect((await send('POST', '/me/academic/import', { cookie, body: {}, csrf: false })).status).toBe(403);
      expect((await send('PUT', '/me/academic/consent', { cookie, body: { accepted: 'sim' } })).status).toBe(400);
      expect((await get('/me/academic', cookie)).headers.get('cache-control')).toBe('no-store');
    });

    it('o histórico, as notas e a senha nunca aparecem em log ou erro', async () => {
      const log = saida.join('\n');
      expect(log).not.toContain('FÍSICA GERAL TEÓRICA I');
      expect(log).not.toContain(SENHA);
      expect(log).not.toContain('MARIA DA SILVA SANTOS');
    });
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

  describe('SIASB (conexão pelo painel)', () => {
    const post = (cookie: string, password: string = SENHA_SIASB) =>
      send('POST', '/connections/siasb', { cookie, body: { password } });
    const meOf = async (cookie: string) => (await (await get('/me', cookie)).json()) as any;
    /** Pessoa com matrícula (perfil de aluno) já logada. */
    let seq = 0;
    async function aluno(who: string): Promise<string> {
      const cookie = await signIn(who);
      // Matrícula única por pessoa (o vínculo fixo não deixa duas contas com a mesma).
      const matricula = `01000000${++seq}`;
      registrations.set((await meOf(cookie)).id, matricula);
      siasbState.username = matricula;
      return cookie;
    }
    beforeEach(() => {
      siasbState.failure = null;
      siasbState.expiresAt = new Date('2099-01-01T00:00:00Z');
    });

    it('sem matrícula: offered false; conectar dá 400 invalid_request', async () => {
      const cookie = await signIn('siasb-sem-matricula');
      expect((await meOf(cookie)).connections.siasb).toEqual({ offered: false, status: 'disconnected', expiresAt: null });
      const r = await post(cookie);
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe('invalid_request');
    });

    it('corpo inválido: 400 invalid_request sem ecoar o valor; sem X-UFBA 403; sem sessão 401', async () => {
      const cookie = await aluno('siasb-entrada');
      const vazio = await send('POST', '/connections/siasb', { cookie, body: {} });
      expect(vazio.status).toBe(400);
      expect(((await vazio.json()) as any).error).toBe('invalid_request');
      const tipo = await send('POST', '/connections/siasb', { cookie, body: { password: 12345678901 } });
      expect(tipo.status).toBe(400);
      expect(JSON.stringify(await tipo.json())).not.toContain('12345678901');
      expect((await send('POST', '/connections/siasb', { cookie, body: { password: SENHA_SIASB }, csrf: false })).status).toBe(403);
      expect((await send('POST', '/connections/siasb', { body: { password: SENHA_SIASB } })).status).toBe(401);
      expect((await send('DELETE', '/connections/siasb', { cookie, csrf: false })).status).toBe(403);
      expect((await send('DELETE', '/connections/siasb')).status).toBe(401);
    });

    it('limita as tentativas de conectar: a 6ª em 10 minutos dá 429 too_many_attempts, sem falar com o SIASB', async () => {
      const cookie = await aluno('siasb-limite');
      siasbState.failure = new SiasbError('CREDENTIAL_REJECTED');
      for (let i = 0; i < 5; i++) expect((await post(cookie)).status).toBe(422);
      const calls = siasbState.courseCalls;
      const sexta = await post(cookie);
      expect(sexta.status).toBe(429);
      expect(((await sexta.json()) as any).error).toBe('too_many_attempts');
      expect(siasbState.courseCalls).toBe(calls);
    });

    it('Origin de fora com X-UFBA válido: 403 csrf_rejected no POST e no DELETE', async () => {
      const cookie = await aluno('siasb-origem');
      // csrf:false derruba X-UFBA E Origin; aqui o X-UFBA vai certo e só a Origin é de fora.
      const headers = { 'x-ufba': '1', origin: 'https://evil.example', cookie };
      const p = await fetch(`${base}/connections/siasb`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ password: SENHA_SIASB }),
      });
      expect(p.status).toBe(403);
      expect(((await p.json()) as any).error).toBe('csrf_rejected');
      const d = await fetch(`${base}/connections/siasb`, { method: 'DELETE', headers });
      expect(d.status).toBe(403);
      expect(((await d.json()) as any).error).toBe('csrf_rejected');
      expect((await meOf(cookie)).connections.siasb.status).toBe('disconnected');
    });

    it('oferecido, conecta (connected + expiresAt), desconecta (disconnected)', async () => {
      const cookie = await aluno('siasb-fluxo');
      expect((await meOf(cookie)).connections.siasb).toEqual({ offered: true, status: 'disconnected', expiresAt: null });
      expect((await post(cookie)).status).toBe(204);
      const chamadas = siasbState.courseCalls;
      expect((await meOf(cookie)).connections.siasb).toEqual({
        offered: true,
        status: 'connected',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      // Conectado: /me não consulta o SIASB.
      expect(siasbState.courseCalls).toBe(chamadas);
      expect((await send('DELETE', '/connections/siasb', { cookie })).status).toBe(204);
      const depois = (await meOf(cookie)).connections.siasb;
      expect(depois.status).toBe('disconnected');
      expect(depois.expiresAt).toBeNull();
    });

    it('expiresAt já passado: /me mostra reconnect_required', async () => {
      const cookie = await aluno('siasb-vencida');
      siasbState.expiresAt = new Date('2020-01-01T00:00:00Z');
      expect((await post(cookie)).status).toBe(204);
      const s = (await meOf(cookie)).connections.siasb;
      expect(s.status).toBe('reconnect_required');
      expect(s.expiresAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it.each([
      ['CREDENTIAL_REJECTED', 422, 'siasb_credentials_rejected'],
      ['PASSWORD_MIGRATION_REQUIRED', 422, 'siasb_password_migration_required'],
      ['UNAVAILABLE', 503, 'siasb_unavailable'],
    ] as const)('falha %s: %i %s, nada conecta e a senha não volta', async (falha, status, codigo) => {
      const cookie = await aluno(`siasb-erro-${falha.toLowerCase()}`);
      // A lista de cursos fica em cache por 10 min: a falha tem de vir do login.
      expect((await meOf(cookie)).connections.siasb.offered).toBe(true);
      siasbState.failure = new SiasbError(falha);
      const r = await post(cookie);
      expect(r.status).toBe(status);
      const corpo = (await r.json()) as any;
      expect(corpo.error).toBe(codigo);
      expect(corpo.message).toEqual(expect.any(String));
      expect(JSON.stringify(corpo)).not.toContain(SENHA_SIASB);
      siasbState.failure = null;
      expect((await meOf(cookie)).connections.siasb.status).toBe('disconnected');
    });

    it('conta do SIASB de outra matrícula: 409 source_account_mismatch', async () => {
      const cookie = await aluno('siasb-outra');
      siasbState.username = '999999999';
      const r = await post(cookie);
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).error).toBe('source_account_mismatch');
      expect((await meOf(cookie)).connections.siasb.status).toBe('disconnected');
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

    // SIASB: sucesso, cada falha, mismatch, sem matrícula e JSON malformado com a senha.
    const sid = ((await (await get('/me', cookie)).json()) as any).id as string;
    registrations.set(sid, MATRICULA);
    siasbState.username = MATRICULA;
    const siasbPost = () => send('POST', '/connections/siasb', { cookie, body: { password: SENHA_SIASB } });
    respostas.push(await (await siasbPost()).text());
    for (const falha of ['CREDENTIAL_REJECTED', 'PASSWORD_MIGRATION_REQUIRED', 'UNAVAILABLE'] as const) {
      siasbState.failure = new SiasbError(falha);
      respostas.push(await (await siasbPost()).text());
    }
    siasbState.failure = null;
    siasbState.username = '999999999';
    respostas.push(await (await siasbPost()).text());
    siasbState.username = MATRICULA;
    registrations.delete(sid);
    respostas.push(await (await siasbPost()).text());
    const quebrado = await fetch(`${base}/connections/siasb`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: WEB, cookie },
      body: `{"password":"${SENHA_SIASB}"`,
    });
    respostas.push(await quebrado.text());

    expect(respostas.join('\n')).not.toContain(SENHA);
    expect(respostas.join('\n')).not.toContain(SENHA_SIASB);
    expect(saida.join('\n')).not.toContain(SENHA);
    expect(saida.join('\n')).not.toContain(SENHA_SIASB);
    expect(JSON.stringify(accounts)).not.toContain(SENHA_SIASB);
  });
});
