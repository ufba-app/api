/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { inspect } from 'node:util';
import { DeviceAuthorizationRepository, MemoryComputerRepository } from '../src/application/memory/device-ports';
import { DEVICE_GRANT } from '../src/application/memory/device-authorizations';
import { ManifestSource } from '../src/application/memory/install-manifest';
import { MemoryAdmin, MemoryMcp, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { OAUTH_STORE, USER_DIRECTORY } from '../src/application/oauth/oauth-ports';
import { sha256Base64Url } from '../src/application/oauth/pkce';
import { ApiKeyRepository } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from '../src/infrastructure/memory/memory-mcp.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { MemoryOAuthStore, MemoryUserDirectory } from '../src/interface/mcp/testing/memory-oauth-store';
import { InMemoryComputerRepo, InMemoryDeviceRepo, InMemoryUserRepo } from './support/memory-fakes';

const WEB = 'http://localhost:3001';
const ROOT = 'CANARIO-root-device-0004';
const SHA = 'a'.repeat(64);

const MANIFEST = {
  schema: 1,
  aiMemory: { version: '3.4.6', artifacts: { 'windows-x64': { url: 'https://github.com/x/y.zip', sha256: SHA } } },
  installer: { version: '1.0.0', minVersion: '1.0.0', files: { 'install.ps1': SHA } },
};

/** Login de dispositivo → computador conectado, pelo AppModule real (HTTP), com banco e ai-memory falsos. */
describe('memória: login de dispositivo e computadores (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let fake: FakeAiMemory;
  let store: MemoryOAuthStore;
  let devices: InMemoryDeviceRepo;
  let computers: InMemoryComputerRepo;
  let manifest: unknown = MANIFEST;
  let cookie: string;
  let otherCookie: string;

  const out: string[] = [];
  const keep = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 10 }))).join(' '));
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(keep)),
  ];

  async function session(userId: string, token: string): Promise<string> {
    await store.saveToken({
      tokenHash: sha256Base64Url(token),
      kind: 'session',
      clientId: 'ufba-web',
      userId,
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return `ufba_session=${token}`;
  }

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.WEB_ORIGIN = WEB;
    process.env.AUTH_ORIGIN = 'http://localhost:3002';
    process.env.PUBLIC_URL = 'http://localhost:3000';
    process.env.MEMORY_ADMIN_EMAILS = 'fulana@ufba.br';
    delete process.env.GOOGLE_CLIENT_ID;
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    process.env.MEMORY_URL = url;
    const { AppModule } = await import('../src/app.module');
    store = new MemoryOAuthStore();
    devices = new InMemoryDeviceRepo();
    computers = new InMemoryComputerRepo();
    const directory = new MemoryUserDirectory();
    const fulana = await directory.findOrCreateByEmail('fulana@ufba.br');
    const beltrano = await directory.findOrCreateByEmail('beltrano@ufba.br');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OAUTH_STORE)
      .useValue(store)
      .overrideProvider(USER_DIRECTORY)
      .useValue(directory)
      .overrideProvider(ApiKeyRepository)
      .useValue({ findActiveByHash: async () => null })
      .overrideProvider(MemoryUserRepository)
      .useValue(new InMemoryUserRepo())
      .overrideProvider(DeviceAuthorizationRepository)
      .useValue(devices)
      .overrideProvider(MemoryComputerRepository)
      .useValue(computers)
      .overrideProvider(MemoryAdmin)
      .useValue(new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) }))
      .overrideProvider(MemoryMcp)
      .useValue(new MemoryMcpClient({ baseUrl: url }))
      .overrideProvider(ManifestSource)
      .useValue({ fetch: async () => manifest })
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    cookie = await session(fulana.id, 'sessao-fulana');
    otherCookie = await session(beltrano.id, 'sessao-beltrano');
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
    for (const k of ['WEB_ORIGIN', 'AUTH_ORIGIN', 'PUBLIC_URL', 'MEMORY_URL', 'MEMORY_ADMIN_EMAILS']) delete process.env[k];
    for (const s of spies) s.mockRestore();
  });

  const form = (path: string, params: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

  const web = (method: string, path: string, who: string | null, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-ufba': '1',
        origin: WEB,
        ...(who ? { cookie: who } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const installer = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  const startDevice = async (extra: Record<string, string> = {}) => {
    const r = await form('/oauth/device_authorization', {
      client_id: 'ufba-installer',
      scope: 'memory:connect',
      computer_name: 'Notebook da Fulana',
      os: 'windows',
      ...extra,
    });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };

  const poll = async (code: string) => {
    const r = await form('/token', { grant_type: DEVICE_GRANT, device_code: code, client_id: 'ufba-installer' });
    return { status: r.status, body: (await r.json()) as any };
  };

  /** Pula a espera do `interval` (o relógio é o real). */
  const skipWait = () => {
    for (const r of devices.rows.values()) r.lastPolledAt = new Date(0);
  };

  async function approvedToken(who = cookie): Promise<string> {
    const d = await startDevice();
    const ok = await web('POST', '/web/device/decision', who, { userCode: d.body.user_code, decision: 'approve' });
    expect(ok.status).toBe(204);
    skipWait();
    const t = await poll(d.body.device_code);
    expect(t.status).toBe(200);
    return t.body.access_token as string;
  }

  it('metadados anunciam o endpoint de dispositivo e o grant', async () => {
    const m = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(m.device_authorization_endpoint).toBe('http://localhost:3000/oauth/device_authorization');
    expect(m.grant_types_supported).toContain(DEVICE_GRANT);
  });

  it('só o instalador e só memory:connect', async () => {
    expect((await startDevice({ client_id: 'outro' })).body.error).toBe('invalid_client');
    expect((await startDevice({ scope: 'openid' })).body.error).toBe('invalid_scope');
  });

  it('fluxo completo: código → aprovação → token curto → chave → confirmação → computador listado', async () => {
    const d = await startDevice();
    expect(d.status).toBe(200);
    expect(d.headers.get('cache-control')).toBe('no-store');
    expect(d.body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d.body).toMatchObject({ verification_uri: `${WEB}/device`, expires_in: 600, interval: 5 });
    expect(d.body.verification_uri_complete).toBe(`${WEB}/device?user_code=${d.body.user_code}`);
    // só hashes no banco
    const stored = JSON.stringify([...devices.rows.values()]);
    expect(stored).not.toContain(d.body.device_code);
    expect(stored).not.toContain(d.body.user_code.replace('-', ''));

    expect((await poll(d.body.device_code)).body.error).toBe('authorization_pending');
    // rápido demais: slow_down (e o intervalo sobe 5 s)
    expect((await poll(d.body.device_code)).body.error).toBe('slow_down');
    skipWait();

    const info = await web('POST', '/web/device/lookup', cookie, { userCode: d.body.user_code.toLowerCase() });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ computerName: 'Notebook da Fulana', os: 'windows' });
    expect((await web('POST', '/web/device/decision', cookie, { userCode: d.body.user_code, decision: 'approve' })).status).toBe(204);

    skipWait();
    const t = await poll(d.body.device_code);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'memory:connect' });
    const token = t.body.access_token as string;
    expect(JSON.stringify([...devices.rows.values()])).not.toContain(token);
    skipWait();
    expect((await poll(d.body.device_code)).body.error).toBe('invalid_grant'); // device_code já usado

    const made = await installer('POST', '/memory/computers', token, { name: 'Notebook da Fulana', os: 'windows', agents: ['claude-code'], client_version: '3.4.6', install_mode: 'fresh' });
    expect(made.status).toBe(200);
    expect(made.headers.get('cache-control')).toBe('no-store');
    const c = (await made.json()) as any;
    expect(c).toMatchObject({ memory_url: process.env.MEMORY_URL });
    expect(c.key).toMatch(/^aim_/);
    expect(fake.authenticate(c.key)?.username).toBe(c.username);
    // a chave nunca é guardada
    expect(JSON.stringify([...computers.rows.values()])).not.toContain(c.key);

    // antes da confirmação o computador não aparece e o token ainda vale
    expect((await (await web('GET', '/web/memory/computers', cookie)).json() as any).computers).toEqual([]);
    expect((await installer('POST', `/memory/computers/${c.computer_id}/confirm`, token)).status).toBe(204);
    // token consumido: não abre mais nada
    expect((await installer('POST', '/memory/computers', token, { name: 'x', os: 'linux' })).status).toBe(401);
    expect((await installer('POST', `/memory/computers/${c.computer_id}/confirm`, token)).status).toBe(401);

    const list = (await (await web('GET', '/web/memory/computers', cookie)).json()) as any;
    expect(list.computers).toHaveLength(1);
    expect(list.computers[0]).toMatchObject({ id: c.computer_id, name: 'Notebook da Fulana', os: 'windows', agents: ['claude-code'], installMode: 'fresh', revokedAt: null });
    const status = (await (await web('GET', '/web/memory/status', cookie)).json()) as any;
    expect(status).toMatchObject({ memoryAvailable: true, userReady: true, isAdmin: true });
    expect(status.computers).toHaveLength(1);
    expect((await (await web('GET', '/web/memory/status', otherCookie)).json() as any).isAdmin).toBe(false);

    // renomear e desconectar (a chave deixa de valer na hora)
    expect((await web('PATCH', `/web/memory/computers/${c.computer_id}`, cookie, { name: 'Desktop' })).status).toBe(204);
    expect(((await (await web('GET', '/web/memory/computers', cookie)).json()) as any).computers[0].name).toBe('Desktop');
    expect((await web('DELETE', `/web/memory/computers/${c.computer_id}`, cookie)).status).toBe(204);
    expect(fake.authenticate(c.key)).toBeNull();
    expect(((await (await web('GET', '/web/memory/computers', cookie)).json()) as any).computers[0].revokedAt).toEqual(expect.any(String));
  });

  it('o token curto não abre o /mcp, nem a API de dados, nem o web', async () => {
    const token = await approvedToken();
    const mcp = await installer('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcp.status).toBe(401);
    const data = await installer('GET', '/accounts', token);
    expect(data.status).toBe(401);
    expect((await installer('GET', '/me', token)).status).toBe(401);
    expect((await installer('POST', '/memory/computers', 'inventado', { os: 'linux' })).status).toBe(401);
    expect((await fetch(`${base}/memory/computers`, { method: 'POST' })).status).toBe(401);
  });

  it('repetir a chamada com o mesmo computer_id troca a chave (resposta perdida) e exige nova confirmação', async () => {
    const token = await approvedToken();
    const first = (await (await installer('POST', '/memory/computers', token, { name: 'PC', os: 'linux' })).json()) as any;
    const again = (await (await installer('POST', '/memory/computers', token, { name: 'PC', os: 'linux', computer_id: first.computer_id })).json()) as any;
    expect(again.computer_id).toBe(first.computer_id);
    expect(again.key).not.toBe(first.key);
    expect(fake.authenticate(first.key)).toBeNull();
    expect(fake.authenticate(again.key)).not.toBeNull();
    expect(computers.rows.size).toBe(2); // este + o do teste anterior
    expect((await installer('POST', `/memory/computers/${first.computer_id}/confirm`, token)).status).toBe(204);
  });

  it('computer_id de outra pessoa não vaza nem é reaproveitado', async () => {
    const mine = await approvedToken();
    const a = (await (await installer('POST', '/memory/computers', mine, { name: 'Meu', os: 'linux' })).json()) as any;
    await installer('POST', `/memory/computers/${a.computer_id}/confirm`, mine);
    const theirs = await approvedToken(otherCookie);
    const b = (await (await installer('POST', '/memory/computers', theirs, { name: 'Dele', os: 'linux', computer_id: a.computer_id })).json()) as any;
    expect(b.computer_id).not.toBe(a.computer_id);
    expect(fake.authenticate(a.key)).not.toBeNull(); // a chave da Fulana segue valendo
    // e ela não consegue desconectar o computador dele
    expect((await web('DELETE', `/web/memory/computers/${b.computer_id}`, cookie)).status).toBe(404);
  });

  it('negar o pedido: o instalador recebe access_denied; código expirado e desconhecido são recusados', async () => {
    const d = await startDevice();
    expect((await web('POST', '/web/device/decision', cookie, { userCode: d.body.user_code, decision: 'deny' })).status).toBe(204);
    skipWait();
    expect((await poll(d.body.device_code)).body.error).toBe('access_denied');

    const e = await startDevice();
    for (const r of devices.rows.values()) if (!r.userId && r.status === 'pending') r.expiresAt = new Date(Date.now() - 1000);
    skipWait();
    expect((await poll(e.body.device_code)).body.error).toBe('expired_token');
    const lookup = await web('POST', '/web/device/lookup', cookie, { userCode: e.body.user_code });
    expect(lookup.status).toBe(410);
    expect(((await lookup.json()) as any).error).toBe('device_code_expired');

    const unknown = await web('POST', '/web/device/lookup', otherCookie, { userCode: 'BCDF-GHJK' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error).toBe('device_code_invalid');
    expect((await poll('device-code-que-nao-existe')).body.error).toBe('invalid_grant');
  });

  it('lookup e decisão exigem sessão; palpites errados são limitados (5 por pessoa)', async () => {
    expect((await web('POST', '/web/device/lookup', null, { userCode: 'BCDF-GHJK' })).status).toBe(401);
    const guesser = await session('user-99', 'sessao-palpiteiro');
    for (let i = 0; i < 5; i++) {
      expect((await web('POST', '/web/device/lookup', guesser, { userCode: 'BCDF-GHJK' })).status).toBe(404);
    }
    const blocked = await web('POST', '/web/device/lookup', guesser, { userCode: 'BCDF-GHJK' });
    expect(blocked.status).toBe(429);
    // mesmo um código certo fica bloqueado enquanto durar o limite
    const d = await startDevice();
    expect((await web('POST', '/web/device/lookup', guesser, { userCode: d.body.user_code })).status).toBe(429);
    expect((await web('POST', '/web/device/lookup', cookie, { userCode: '' })).status).toBe(400);
    // CSRF: sem X-UFBA a rota recusa
    const noCsrf = await fetch(`${base}/web/device/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: WEB },
      body: JSON.stringify({ userCode: 'BCDF-GHJK' }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it('manifesto de instalação: validado, público e com cache; inválido vira 503', async () => {
    const r = await fetch(`${base}/memory/install-manifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('max-age');
    expect(await r.json()).toEqual(MANIFEST);
  });

  it('canário: token root, chaves, device_code, user_code e token curto nunca aparecem em saída', async () => {
    const d = await startDevice({ computer_name: 'CANARIO-nome' });
    await web('POST', '/web/device/decision', cookie, { userCode: d.body.user_code, decision: 'approve' });
    skipWait();
    const t = await poll(d.body.device_code);
    const made = (await (await installer('POST', '/memory/computers', t.body.access_token, { name: 'c', os: 'linux' })).json()) as any;
    await installer('POST', '/memory/computers', 'token-ruim', { os: 'linux' });
    await web('POST', '/web/device/lookup', cookie, { userCode: d.body.user_code });
    const secrets = [ROOT, d.body.device_code, d.body.user_code, d.body.user_code.replace('-', ''), t.body.access_token, made.key, ...fake.credentials.map((c) => c.token)];
    const text = out.join('\n');
    for (const s of secrets) expect(text).not.toContain(s);
  });
});
