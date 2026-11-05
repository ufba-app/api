/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { McpTestingModule, TEST_API_KEY } from '../testing/mcp-testing.module';
import { isValidRedirectUri } from '../../../application/oauth/oauth.service';
import { verifyPkceS256 } from '../../../application/oauth/pkce';

const VERIFIER = 'a'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://localhost:9999/callback';

describe('PKCE', () => {
  it('aceita o verifier correto e rejeita o errado', () => {
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyPkceS256('b'.repeat(50), CHALLENGE)).toBe(false);
    expect(verifyPkceS256('curto', CHALLENGE)).toBe(false);
  });
});

describe('redirect_uri', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['http://localhost:3118/cb', true],
    ['http://127.0.0.1/cb', true],
    ['http://evil.example/cb', false],
    ['myapp://cb', false],
    ['https://x.example/cb#frag', false],
    ['nao-e-url', false],
  ])('%s -> %s', (uri, ok) => {
    expect(isValidRedirectUri(uri)).toBe(ok);
  });
});

describe('servidor OAuth 2.1 (HTTP)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    delete process.env.OAUTH_AUTHORIZE_SECRET;
    delete process.env.PUBLIC_URL;
    app = await NestFactory.create(McpTestingModule, { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(() => app.close());

  const post = (path: string, body: unknown, form = false) =>
    fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });

  it('publica os metadados', async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as any;
    expect(pr.resource).toBe(`${base}/mcp`);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${base}/register`);
  });

  it('401 do /mcp aponta para o metadata', async () => {
    const res = await post('/mcp', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('fluxo completo: register -> authorize -> token -> /mcp -> refresh', async () => {
    const reg = await post('/register', { client_name: 'Teste', redirect_uris: [REDIRECT] });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json() as any;

    const q = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      state: 'xyz',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    const page = await fetch(`${base}/authorize?${q}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const txn = /name="txn" value="([^"]+)"/.exec(html)![1];
    expect(html).not.toMatch(/token/i); // sem campo para colar token

    const ident = await post('/authorize', { txn, acao: 'identificar', email: 'aluno@example.com' }, true);
    const connect = await ident.text();
    expect(connect).toContain('Conectar Classroom');
    expect(connect).toContain('Conectar Moodle');
    expect(connect).not.toMatch(/type="(text|password)"/);

    const done = await post('/authorize', { txn, acao: 'concluir' }, true);
    expect(done.status).toBe(303);
    const back = new URL(done.headers.get('location')!);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    // verifier errado falha e queima o code
    const bad = await post('/token', { grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: 'b'.repeat(50) }, true);
    expect(bad.status).toBe(400);

    // novo code, desta vez correto
    const again = await post('/authorize', { txn, acao: 'concluir' }, true);
    expect(again.status).toBe(400); // transação já consumida
  });

  it('token: code válido + PKCE gera access/refresh que abrem o /mcp; code é de uso único', async () => {
    const { client_id } = await (await post('/register', { redirect_uris: [REDIRECT] })).json() as any;
    const q = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, code_challenge_method: 'S256',
    });
    const txn = /name="txn" value="([^"]+)"/.exec(await (await fetch(`${base}/authorize?${q}`)).text())![1];
    await post('/authorize', { txn, acao: 'identificar', email: 'a@example.com' }, true);
    const done = await post('/authorize', { txn, acao: 'concluir' }, true);
    const code = new URL(done.headers.get('location')!).searchParams.get('code')!;

    const params = { grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER };
    const ok = await post('/token', params, true);
    expect(ok.status).toBe(200);
    const tok = await ok.json() as any;
    expect(tok.token_type).toBe('Bearer');

    expect((await post('/token', params, true)).status).toBe(400); // reuso

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(200);

    const ref = await post('/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }, true);
    expect(ref.status).toBe(200);
    // refresh rotacionado: o antigo não vale mais
    expect((await post('/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id }, true)).status).toBe(400);
  });

  it('rejeita redirect_uri não registrado e PKCE ausente (sem redirecionar)', async () => {
    const { client_id } = await (await post('/register', { redirect_uris: [REDIRECT] })).json() as any;
    const evil = await fetch(`${base}/authorize?${new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'http://localhost:1/evil',
      code_challenge: CHALLENGE, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    expect(evil.status).toBe(400);
    const nopkce = await fetch(`${base}/authorize?${new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: REDIRECT,
    })}`, { redirect: 'manual' });
    expect(nopkce.status).toBe(400);
  });

  it('registro recusa redirect_uri insegura', async () => {
    const res = await post('/register', { redirect_uris: ['http://evil.example/cb'] });
    expect(res.status).toBe(400);
  });

  it('o Bearer de chave de API continua valendo no /mcp', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });
});
