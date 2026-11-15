/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { DEVICE_GRANT } from '../src/application/memory/device-authorizations';
import { DeviceAuthorizationRepository, MemoryComputerRepository } from '../src/application/memory/device-ports';
import { ManifestSource } from '../src/application/memory/install-manifest';
import { MemoryAdmin, MemoryMcp, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { ClientDirectory, type ClientMetadataFetcher } from '../src/application/oauth/client-directory';
import { OAUTH_STORE, USER_DIRECTORY } from '../src/application/oauth/oauth-ports';
import { sha256Base64Url } from '../src/application/oauth/pkce';
import { ApiKeyRepository } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { FileVerifiedApps } from '../src/infrastructure/oauth/client-metadata';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { MemoryOAuthStore, MemoryUserDirectory } from '../src/interface/mcp/testing/memory-oauth-store';
import { CLIENT_DIRECTORY } from '../src/interface/web/web-tokens';
import { InMemoryComputerRepo, InMemoryDeviceRepo, InMemoryUserRepo } from './support/memory-fakes';
import { UserPermissionRepository } from '../src/application/ports/permissions';
import { InMemoryPermissions } from './support/permission-fake';
import { InMemoryCredentials, InMemoryVaults } from './support/sigaa-store-fake';
import { SigaaCredentialRepository, SigaaVaultRepository } from '../src/application/ports/repositories';

/**
 * CONFORMIDADE DO OAUTH DO MCP: um caso ponta a ponta (authorize → aprovação do painel → code → token → /mcp com Bearer) por
 * variação que um cliente pode usar, mais os negativos. A ideia é que qualquer agente que siga o padrão (OAuth 2.1, PKCE,
 * RFC 8252 para apps nativos, CIMD, DCR, RFC 8628) funcione sem estudo caso a caso. Sem rede: o documento CIMD é falso.
 */

const WEB = 'http://localhost:3001';
const AUTH = 'http://localhost:3002';
const ROOT = 'CANARIO-root-conformance-0001';
const VERIFIER = 'v'.repeat(60);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

/** O documento de metadados do Claude Code (CIMD): redirects de loopback SEM porta. */
const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
const CIMD_DOCS = new Map<string, unknown>();

const fakeFetcher: ClientMetadataFetcher = {
  fetchDocument: async (url) => {
    if (!CIMD_DOCS.has(url)) throw new Error('404');
    return CIMD_DOCS.get(url);
  },
  fetchLogo: async () => null,
};

describe('conformidade do OAuth do MCP (HTTP, aplicação real)', () => {
  let app: INestApplication;
  let base: string;
  let fake: FakeAiMemory;
  let devices: InMemoryDeviceRepo;
  let cookie: string;

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.WEB_ORIGIN = WEB;
    process.env.AUTH_ORIGIN = AUTH;
    process.env.PUBLIC_URL = 'http://localhost:3000';
    process.env.ADMIN_EMAILS = 'fulana@ufba.br';
    delete process.env.GOOGLE_CLIENT_ID;
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    process.env.MEMORY_URL = url;
    const { AppModule } = await import('../src/app.module');
    const store = new MemoryOAuthStore();
    devices = new InMemoryDeviceRepo();
    const directory = new MemoryUserDirectory();
    const user = await directory.findOrCreateByEmail('fulana@ufba.br');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OAUTH_STORE)
      .useValue(store)
      .overrideProvider(USER_DIRECTORY)
      .useValue(directory)
      .overrideProvider(CLIENT_DIRECTORY)
      .useValue(new ClientDirectory(store, fakeFetcher, new FileVerifiedApps(), () => 'http://localhost:3000'))
      .overrideProvider(ApiKeyRepository)
      .useValue({ findActiveByHash: async () => null })
      .overrideProvider(UserPermissionRepository)
      .useValue(new InMemoryPermissions())
      .overrideProvider(SigaaCredentialRepository)
      .useValue(new InMemoryCredentials())
      .overrideProvider(SigaaVaultRepository)
      .useValue(new InMemoryVaults())
      .overrideProvider(MemoryUserRepository)
      .useValue(new InMemoryUserRepo())
      .overrideProvider(DeviceAuthorizationRepository)
      .useValue(devices)
      .overrideProvider(MemoryComputerRepository)
      .useValue(new InMemoryComputerRepo())
      .overrideProvider(MemoryAdmin)
      .useValue(new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) }))
      .overrideProvider(MemoryMcp)
      .useValue(new MemoryMcpClient({ baseUrl: url }))
      .overrideProvider(ManifestSource)
      .useValue({ fetch: async () => ({}) })
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');

    await store.saveToken({
      tokenHash: sha256Base64Url('sessao-conformidade'),
      kind: 'session',
      clientId: 'ufba-web',
      userId: user.id,
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    cookie = 'ufba_session=sessao-conformidade';
    CIMD_DOCS.set(CLAUDE_CODE_CIMD, {
      client_id: CLAUDE_CODE_CIMD,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    });
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
    for (const k of ['WEB_ORIGIN', 'AUTH_ORIGIN', 'PUBLIC_URL', 'MEMORY_URL', 'ADMIN_EMAILS']) delete process.env[k];
    CIMD_DOCS.clear();
  });

  // ---- ajudantes ----

  const form = (path: string, params: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

  const register = async (redirect_uris: string[]) => {
    const r = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris, client_name: 'Cliente de teste' }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  const dcr = async (uris: string[]): Promise<string> => {
    const r = await register(uris);
    expect(r.status).toBe(201);
    return r.body.client_id as string;
  };

  /** /authorize e a aprovação do painel. Devolve o `code` (e o redirect final) ou o erro mostrado pelo web. */
  async function authorize(
    client_id: string,
    redirect_uri: string,
    extra: Record<string, string> = {},
    drop: string[] = [],
  ): Promise<{ ok: true; code: string; redirectTo: URL; state: string | null } | { ok: false; error: string; message: string }> {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'estado-123',
      ...extra,
    });
    for (const k of drop) q.delete(k);
    const r = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get('location')!);
    if (loc.origin === AUTH && loc.pathname === '/authorize/error') {
      return { ok: false, error: loc.searchParams.get('error')!, message: loc.searchParams.get('message')! };
    }
    expect(`${loc.origin}${loc.pathname}`).toBe(`${AUTH}/authorize`);
    const approve = await fetch(`${base}/authorize/requests/${loc.searchParams.get('request')}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: WEB, cookie },
      body: '{}',
    });
    expect(approve.status).toBe(200);
    const redirectTo = new URL(((await approve.json()) as any).redirectTo);
    return { ok: true, code: redirectTo.searchParams.get('code')!, redirectTo, state: redirectTo.searchParams.get('state') };
  }

  const token = (params: Record<string, string>) => form('/token', params);

  const mcpTools = (access: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  /** Ponta a ponta: authorize → code → token → /mcp com Bearer. Devolve os tokens. */
  async function endToEnd(client_id: string, redirect_uri: string, _esperado?: string): Promise<{ access: string; refresh: string }> {
    const a = await authorize(client_id, redirect_uri);
    if (!a.ok) throw new Error(`authorize recusou: ${a.error} ${a.message}`);
    // O código volta para a MESMA URL pedida (com a porta, se tinha), com o state.
    expect(a.redirectTo.href.split('?')[0]).toBe(new URL(redirect_uri).href);
    expect(a.state).toBe('estado-123');
    const t = await token({ grant_type: 'authorization_code', code: a.code, client_id, redirect_uri, code_verifier: VERIFIER });
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    const body = (await t.json()) as any;
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect((await mcpTools(body.access_token)).status).toBe(200);
    return { access: body.access_token, refresh: body.refresh_token };
  }

  // ---- positivos, um por variação ----

  describe('positivos (authorize → code → token → /mcp)', () => {
    it('(1) DCR com redirect de loopback e PORTA ALEATÓRIA (cliente CLI: registra sem porta, pede com porta)', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      await endToEnd(client_id, 'http://localhost:51234/callback', 'http://localhost:51234/callback');
    });

    it('(2) CIMD: o documento do Claude Code (redirects sem porta) com porta aleatória, sem rede', async () => {
      await endToEnd(CLAUDE_CODE_CIMD, 'http://localhost:60999/callback', 'http://localhost:60999/callback');
      await endToEnd(CLAUDE_CODE_CIMD, 'http://127.0.0.1:60998/callback', 'http://127.0.0.1:60998/callback');
    });

    it('(2b) CIMD com redirect https e com esquema privado', async () => {
      const https = 'https://agente.exemplo.com/.well-known/client.json';
      CIMD_DOCS.set(https, { client_id: https, client_name: 'Agente', redirect_uris: ['https://agente.exemplo.com/oauth/callback'] });
      await endToEnd(https, 'https://agente.exemplo.com/oauth/callback', 'https://agente.exemplo.com/oauth/callback');
      const priv = 'https://editor.exemplo.com/client.json';
      CIMD_DOCS.set(priv, { client_id: priv, redirect_uris: ['editor://exemplo.oauth/callback'] });
      await endToEnd(priv, 'editor://exemplo.oauth/callback', 'editor://exemplo.oauth/callback');
    });

    it('(3) redirect https fixo (estilo claude.ai / ChatGPT)', async () => {
      const client_id = await dcr(['https://claude.ai/api/mcp/auth_callback']);
      await endToEnd(client_id, 'https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback');
    });

    it.each([
      ['cursor://anysphere.cursor-retrieval/oauth/user-mcp/callback'],
      ['vscode://vscode.github-authentication/did-authenticate'],
      ['com.exemplo.app:/oauth2redirect'],
    ])('(4) esquema próprio registrado por /register: %s (exato, RFC 8252 §7.1)', async (uri) => {
      const client_id = await dcr([uri]);
      await endToEnd(client_id, uri);
    });

    it.each([['http://127.0.0.1', 'http://127.0.0.1:40001/cb'], ['http://[::1]', 'http://[::1]:40002/cb'], ['http://localhost', 'http://localhost:40003/cb']])(
      '(5) loopback %s com porta aleatória',
      async (host, pedido) => {
        const client_id = await dcr([`${host}/cb`]);
        await endToEnd(client_id, pedido, pedido);
      },
    );

    it('(7) refresh_token: troca por um par novo que abre o /mcp; o refresh antigo deixa de valer (rotação)', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      const first = await endToEnd(client_id, 'http://localhost:52000/callback', 'http://localhost:52000/callback');
      const r = await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id });
      expect(r.status).toBe(200);
      const next = (await r.json()) as any;
      expect(next.access_token).not.toBe(first.access);
      expect(next.refresh_token).not.toBe(first.refresh);
      expect((await mcpTools(next.access_token)).status).toBe(200);
      expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh, client_id })).status).toBe(400);
    });
  });

  // ---- (6) device flow (RFC 8628) ----

  describe('(6) device flow (RFC 8628, instalador da memória)', () => {
    const skipWait = () => {
      for (const r of devices.rows.values()) r.lastPolledAt = new Date(0);
    };
    const start = () =>
      form('/oauth/device_authorization', { client_id: 'ufba-installer', scope: 'memory:connect', computer_name: 'Notebook', os: 'linux' });

    it('anuncia o endpoint nos metadados; código → pendente → aprovação → token; o device_code vale uma vez', async () => {
      const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
      expect(meta.device_authorization_endpoint).toBe('http://localhost:3000/oauth/device_authorization');
      expect(meta.grant_types_supported).toContain(DEVICE_GRANT);

      const d = (await (await start()).json()) as any;
      expect(d).toMatchObject({ expires_in: 600, interval: 5 });
      const poll = async () => (await (await token({ grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: 'ufba-installer' })).json()) as any;
      expect((await poll()).error).toBe('authorization_pending');
      skipWait();
      const decision = await fetch(`${base}/device/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ufba': '1', origin: WEB, cookie },
        body: JSON.stringify({ userCode: d.user_code, decision: 'approve' }),
      });
      expect(decision.status).toBe(204);
      skipWait();
      const ok = await poll();
      expect(ok).toMatchObject({ token_type: 'Bearer', scope: 'memory:connect' });
      expect(ok.access_token).toBeTruthy();
      skipWait();
      expect((await poll()).error).toBe('invalid_grant');
    });

    it('cliente e escopo desconhecidos são recusados', async () => {
      expect(((await (await form('/oauth/device_authorization', { client_id: 'outro', scope: 'memory:connect' })).json()) as any).error).toBe('invalid_client');
      expect(((await (await form('/oauth/device_authorization', { client_id: 'ufba-installer', scope: 'openid' })).json()) as any).error).toBe('invalid_scope');
    });
  });

  // ---- tela de consentimento: local e verificado ----

  describe('tela de consentimento (RequestInfo): local não é verificado', () => {
    async function info(client_id: string, redirect_uri: string) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      });
      const r = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
      const id = new URL(r.headers.get('location')!).searchParams.get('request')!;
      const res = await fetch(`${base}/authorize/requests/${id}`);
      expect(res.status).toBe(200);
      return ((await res.json()) as any).client as Record<string, unknown>;
    }

    it('Claude Code (CIMD em claude.ai, redirect em localhost): verificado como "Claude" e local', async () => {
      expect(await info(CLAUDE_CODE_CIMD, 'http://localhost:51234/callback')).toMatchObject({
        domain: 'localhost',
        local: true,
        verified: true,
        name: 'Claude',
        metadata: 'present',
      });
    });

    it('cliente CIMD de OUTRO host que se diz "Claude Code": local, mas sem selo', async () => {
      const url = 'https://falso-claude.exemplo.com/client.json';
      CIMD_DOCS.set(url, { client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] });
      expect(await info(url, 'http://localhost:51234/callback')).toMatchObject({ local: true, verified: false });
    });

    it('DCR em localhost e em esquema privado: local, sem selo e sem nome do cliente', async () => {
      const a = await info(await dcr(['http://localhost/cb']), 'http://localhost:51234/cb');
      expect(a).toMatchObject({ local: true, verified: false, name: null });
      const b = await info(await dcr(['cursor://anysphere.cursor-retrieval/cb']), 'cursor://anysphere.cursor-retrieval/cb');
      expect(b).toMatchObject({ local: true, verified: false });
    });

    it('https de terceiros: não é local; claude.ai por /register continua verificado pelo domínio', async () => {
      expect(await info(await dcr(['https://app.exemplo.com/cb']), 'https://app.exemplo.com/cb')).toMatchObject({ local: false, verified: false });
      expect(await info(await dcr(['https://claude.ai/api/mcp/auth_callback']), 'https://claude.ai/api/mcp/auth_callback')).toMatchObject({
        local: false,
        verified: true,
        name: 'Claude',
      });
    });

    it('apps autorizados: o Claude Code (dois hosts de loopback no documento) aparece como "Claude", verificado e local', async () => {
      await endToEnd(CLAUDE_CODE_CIMD, 'http://localhost:51999/callback');
      const res = await fetch(`${base}/authorized-apps`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const app = ((await res.json()) as any).apps.find((a: any) => a.clientId === CLAUDE_CODE_CIMD);
      expect(app).toMatchObject({ verified: true, name: 'Claude', local: true });
    });
  });

  // ---- registro (DCR) ----

  describe('registro dinâmico (DCR)', () => {
    it.each([
      [['http://evil.example/cb']],
      [['javascript:alert(1)']],
      [['data:text/html,x']],
      [['file:///etc/passwd']],
      [['cursor://*/cb']],
      [['https://x.example/cb#frag']],
      [['http://user:pw@localhost/cb']],
      [[]],
    ])('recusa redirect inválido: %j', async (uris) => {
      expect((await register(uris as string[])).status).toBe(400);
    });

    it('aceita https, loopback e esquema privado, e devolve o client_id', async () => {
      const r = await register(['https://x.example/cb', 'http://localhost/cb', 'meuapp://cb']);
      expect(r.status).toBe(201);
      expect(r.body.client_id).toBeTruthy();
    });
  });

  // ---- negativos do /authorize ----

  describe('negativos do /authorize (página de erro do web, nunca o cliente)', () => {
    it.each([
      ['host diferente', 'http://evil.test:54321/callback'],
      ['host parecido', 'http://localhost.evil.test:54321/callback'],
      ['path diferente', 'http://localhost:54321/outro'],
      ['query a mais', 'http://localhost:54321/callback?x=1'],
      ['https em localhost sem registro de https', 'https://localhost:54321/callback'],
      ['outro loopback (127.0.0.1 não vale por localhost)', 'http://127.0.0.1:54321/callback'],
      ['esquema privado não registrado', 'cursor://anysphere.cursor-retrieval/oauth/callback'],
      ['credenciais na URL', 'http://user:pw@localhost:54321/callback'],
      ['fragmento', 'http://localhost:54321/callback#x'],
    ])('loopback registrado: %s é recusado', async (_nome, pedido) => {
      const client_id = await dcr(['http://localhost/callback']);
      const a = await authorize(client_id, pedido);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error).toBe('invalid_request');
    });

    it('porta em host que NÃO é loopback continua exata (https)', async () => {
      const client_id = await dcr(['https://app.exemplo.com/cb']);
      expect((await authorize(client_id, 'https://app.exemplo.com:8443/cb')).ok).toBe(false);
      expect((await authorize(client_id, 'http://app.exemplo.com/cb')).ok).toBe(false);
      expect((await authorize(client_id, 'https://app.exemplo.com/cb')).ok).toBe(true);
    });

    it('esquema privado é exato: outro path, outro host e outro esquema são recusados; sem curinga', async () => {
      const client_id = await dcr(['cursor://anysphere.cursor-retrieval/oauth/callback']);
      for (const pedido of [
        'cursor://anysphere.cursor-retrieval/oauth/outro',
        'cursor://outro.host/oauth/callback',
        'vscode://anysphere.cursor-retrieval/oauth/callback',
        'cursor://anysphere.cursor-retrieval/oauth/callback?x=1',
      ]) {
        expect([pedido, (await authorize(client_id, pedido)).ok]).toEqual([pedido, false]);
      }
    });

    it('CIMD: redirect fora do documento é recusado; documento com client_id diferente da URL não vale', async () => {
      expect((await authorize(CLAUDE_CODE_CIMD, 'http://evil.test:5000/callback')).ok).toBe(false);
      expect((await authorize(CLAUDE_CODE_CIMD, 'http://localhost:5000/outro')).ok).toBe(false);
      const falso = 'https://falso.exemplo.com/client.json';
      CIMD_DOCS.set(falso, { client_id: 'https://outro.exemplo.com/client.json', redirect_uris: ['http://localhost/cb'] });
      const a = await authorize(falso, 'http://localhost:5000/cb');
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error).toBe('invalid_client');
    });

    it('client_id desconhecido: invalid_client', async () => {
      const a = await authorize('nao-existe', 'http://localhost:5000/cb');
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error).toBe('invalid_client');
    });

    it('PKCE: ausente ou plain é recusado (só S256)', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      const url = 'http://localhost:54000/callback';
      for (const [extra, drop] of [
        [{}, ['code_challenge']],
        [{}, ['code_challenge_method']],
        [{ code_challenge_method: 'plain', code_challenge: VERIFIER }, []],
      ] as const) {
        const a = await authorize(client_id, url, { ...extra }, [...drop]);
        expect(a.ok).toBe(false);
        if (!a.ok) expect(a.error).toBe('invalid_request');
      }
    });

    it('response_type diferente de code: recusado', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      const a = await authorize(client_id, 'http://localhost:54000/callback', { response_type: 'token' });
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error).toBe('unsupported_response_type');
    });
  });

  // ---- negativos do /token ----

  describe('negativos do /token', () => {
    async function codeFor(client_id: string, pedido: string) {
      const a = await authorize(client_id, pedido);
      if (!a.ok) throw new Error('authorize recusou');
      return a.code;
    }

    it('redirect_uri do /token diferente do pedido: recusado (porta, ausência ou outro host)', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      const pedido = 'http://localhost:54100/callback';
      for (const redirect_uri of ['http://localhost:54101/callback', 'http://localhost/callback', 'http://localhost:54100/outro', 'http://127.0.0.1:54100/callback']) {
        const code = await codeFor(client_id, pedido);
        const r = await token({ grant_type: 'authorization_code', code, client_id, redirect_uri, code_verifier: VERIFIER });
        expect([redirect_uri, r.status]).toEqual([redirect_uri, 400]);
        expect(((await r.json()) as any).error).toBe('invalid_grant');
      }
      // sem redirect_uri algum também falha (o pedido o tinha)
      const code = await codeFor(client_id, pedido);
      expect((await token({ grant_type: 'authorization_code', code, client_id, code_verifier: VERIFIER })).status).toBe(400);
    });

    it('code_verifier errado ou ausente: recusado; e o code é de uso único', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      const pedido = 'http://localhost:54200/callback';
      const code = await codeFor(client_id, pedido);
      const ruim = await token({ grant_type: 'authorization_code', code, client_id, redirect_uri: pedido, code_verifier: 'x'.repeat(60) });
      expect(ruim.status).toBe(400);
      expect(((await ruim.json()) as any).error).toBe('invalid_grant');
      const code2 = await codeFor(client_id, pedido);
      expect((await token({ grant_type: 'authorization_code', code: code2, client_id, redirect_uri: pedido })).status).toBe(400);
      const code3 = await codeFor(client_id, pedido);
      const params = { grant_type: 'authorization_code', code: code3, client_id, redirect_uri: pedido, code_verifier: VERIFIER };
      expect((await token(params)).status).toBe(200);
      expect((await token(params)).status).toBe(400); // reuso
    });

    it('code emitido para um client_id não vale para outro', async () => {
      const a = await dcr(['http://localhost/callback']);
      const b = await dcr(['http://localhost/callback']);
      const pedido = 'http://localhost:54300/callback';
      const code = await codeFor(a, pedido);
      expect((await token({ grant_type: 'authorization_code', code, client_id: b, redirect_uri: pedido, code_verifier: VERIFIER })).status).toBe(400);
    });

    it('grant_type desconhecido e refresh inválido: recusados', async () => {
      const client_id = await dcr(['http://localhost/callback']);
      expect((await token({ grant_type: 'password', client_id, username: 'x', password: 'y' })).status).toBe(400);
      expect((await token({ grant_type: 'refresh_token', refresh_token: 'invalido', client_id })).status).toBe(400);
    });

    it('/mcp sem Bearer ou com token inválido: 401 apontando o metadata', async () => {
      const sem = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(sem.status).toBe(401);
      expect(sem.headers.get('www-authenticate')).toContain('resource_metadata=');
      expect((await mcpTools('token-invalido')).status).toBe(401);
    });
  });
});
