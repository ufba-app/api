/* eslint-disable @typescript-eslint/no-explicit-any */
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { McpTestingModule, TEST_API_KEY } from '../testing/mcp-testing.module';
import { isValidRedirectUri, type OAuthService } from '../../../application/oauth/oauth.service';
import { OAUTH_SERVICE } from './oauth.controller';
import { verifyPkceS256 } from '../../../application/oauth/pkce';
import { AuthenticatorsMcpAuth } from '../mcp-auth';

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
    delete process.env.WEB_ORIGIN;
    delete process.env.AUTH_ORIGIN;
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

  const authorizeQuery = (client_id: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      ...extra,
    });

  /** O que a tela de consentimento do web faria: identificar a pessoa e aprovar. Devolve o redirect para o cliente. */
  const approveAsWeb = async (requestId: string, email: string) => {
    const oauth = app.get<OAuthService>(OAUTH_SERVICE);
    await oauth.identify(requestId, email);
    return new URL(await oauth.complete(requestId));
  };

  it('/authorize só redireciona para a tela de consentimento do web: nenhuma página HTML', async () => {
    const { client_id } = (await (await post('/register', { client_name: 'Teste', redirect_uris: [REDIRECT] })).json()) as any;
    const r = await fetch(`${base}/authorize?${authorizeQuery(client_id, { state: 'xyz' })}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('content-type') ?? '').not.toContain('text/html');
    const loc = new URL(r.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe('http://localhost:3001/authorize');
    const back = await approveAsWeb(loc.searchParams.get('request')!, 'aluno@example.com');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('code')).toBeTruthy();
  });

  it('token: code válido + PKCE gera access/refresh que abrem o /mcp; code é de uso único', async () => {
    const { client_id } = (await (await post('/register', { redirect_uris: [REDIRECT] })).json()) as any;
    const r = await fetch(`${base}/authorize?${authorizeQuery(client_id)}`, { redirect: 'manual' });
    const requestId = new URL(r.headers.get('location')!).searchParams.get('request')!;
    const code = (await approveAsWeb(requestId, 'a@example.com')).searchParams.get('code')!;

    // verifier errado falha
    const bad = { grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: 'b'.repeat(50) };
    expect((await post('/token', bad, true)).status).toBe(400);
  });

  it('token: troca, uso único, /mcp e refresh rotacionado', async () => {
    const { client_id } = (await (await post('/register', { redirect_uris: [REDIRECT] })).json()) as any;
    const r = await fetch(`${base}/authorize?${authorizeQuery(client_id)}`, { redirect: 'manual' });
    const requestId = new URL(r.headers.get('location')!).searchParams.get('request')!;
    const code = (await approveAsWeb(requestId, 'b@example.com')).searchParams.get('code')!;

    const params = { grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER };
    const ok = await post('/token', params, true);
    expect(ok.status).toBe(200);
    const tok = (await ok.json()) as any;
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

  it('redirect_uri não registrado e PKCE ausente: página de erro do web, nunca o cliente', async () => {
    const { client_id } = (await (await post('/register', { redirect_uris: [REDIRECT] })).json()) as any;
    for (const q of [
      authorizeQuery(client_id, { redirect_uri: 'http://localhost:1/evil' }),
      new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT }),
    ]) {
      const r = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')!.startsWith('http://localhost:3001/authorize/error?')).toBe(true);
    }
  });

  describe('loopback http: a porta é livre (RFC 8252), o resto é exato', () => {
    const SEM_PORTA = 'http://localhost/callback';
    const registrar = async () =>
      ((await (await post('/register', { redirect_uris: [SEM_PORTA, 'http://127.0.0.1/callback'] })).json()) as any).client_id as string;

    it('porta aleatória aceita no /authorize; o código volta para a MESMA URL com porta; o /token exige a mesma URL (com porta)', async () => {
      const client_id = await registrar();
      const pedido = 'http://localhost:54321/callback';
      const r = await fetch(`${base}/authorize?${authorizeQuery(client_id, { redirect_uri: pedido, state: 's1' })}`, { redirect: 'manual' });
      expect(r.status).toBe(303);
      const loc = new URL(r.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe('http://localhost:3001/authorize'); // não é a página de erro
      const back = await approveAsWeb(loc.searchParams.get('request')!, 'loop@example.com');
      expect(`${back.origin}${back.pathname}`).toBe('http://localhost:54321/callback');
      const code = back.searchParams.get('code')!;

      // /token: o redirect_uri tem que ser exatamente o do pedido (com a porta). Sem porta ou outra porta: recusado.
      const base_ = { grant_type: 'authorization_code', code, client_id, code_verifier: VERIFIER };
      expect((await post('/token', { ...base_, redirect_uri: SEM_PORTA }, true)).status).toBe(400);
      expect((await post('/token', { ...base_, redirect_uri: 'http://localhost:54322/callback' }, true)).status).toBe(400);
    });

    it('com a mesma URL (porta incluída) o /token troca o código', async () => {
      const client_id = await registrar();
      const pedido = 'http://127.0.0.1:60123/callback';
      const r = await fetch(`${base}/authorize?${authorizeQuery(client_id, { redirect_uri: pedido })}`, { redirect: 'manual' });
      const requestId = new URL(r.headers.get('location')!).searchParams.get('request')!;
      const code = (await approveAsWeb(requestId, 'loop2@example.com')).searchParams.get('code')!;
      const ok = await post('/token', { grant_type: 'authorization_code', code, client_id, redirect_uri: pedido, code_verifier: VERIFIER }, true);
      expect(ok.status).toBe(200);
    });

    it('host, path, query ou scheme diferentes, e porta em host que não é loopback: página de erro do web, nunca o cliente', async () => {
      const client_id = await registrar();
      for (const redirect_uri of [
        'http://evil.test:54321/callback',
        'http://localhost.evil.test:54321/callback',
        'http://localhost:54321/outro',
        'http://localhost:54321/callback?x=1',
        'https://localhost:54321/callback',
        'http://[::1]:54321/callback',
      ]) {
        const r = await fetch(`${base}/authorize?${authorizeQuery(client_id, { redirect_uri })}`, { redirect: 'manual' });
        expect([redirect_uri, r.status]).toEqual([redirect_uri, 303]);
        expect([redirect_uri, r.headers.get('location')!.startsWith('http://localhost:3001/authorize/error?')]).toEqual([redirect_uri, true]);
      }
    });

    it('porta em host que não é loopback continua exata (cliente https registrado)', async () => {
      const { client_id } = (await (await post('/register', { redirect_uris: ['https://app.exemplo.com/cb'] })).json()) as any;
      const r = await fetch(`${base}/authorize?${authorizeQuery(client_id, { redirect_uri: 'https://app.exemplo.com:8443/cb' })}`, { redirect: 'manual' });
      expect(r.headers.get('location')!.startsWith('http://localhost:3001/authorize/error?')).toBe(true);
    });
  });

  it('registro recusa redirect_uri insegura', async () => {
    const res = await post('/register', { redirect_uris: ['http://evil.example/cb'] });
    expect(res.status).toBe(400);
  });

  it('as telas antigas do backend não existem mais (404)', async () => {
    for (const [method, path] of [
      ['POST', '/authorize'],
      ['GET', '/oauth/login/google?txn=x'],
      ['GET', '/oauth/connect?txn=x'],
      ['GET', '/oauth/connect/classroom?txn=x'],
      ['GET', '/oauth/connect/moodle?txn=x'],
      ['POST', '/oauth/connect/moodle'],
      ['GET', '/oauth/moodle/capture?u=web%2Bufba%3A%2F%2Ftoken%3Dx'],
      ['POST', '/oauth/connect/sigaa'],
    ] as const) {
      const r = await fetch(`${base}${path}`, { method, redirect: 'manual' });
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
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

describe('AuthenticatorsMcpAuth', () => {
  it('repassa clientId e chave ao principal', async () => {
    const chave = Buffer.alloc(32, 9);
    const auth = new AuthenticatorsMcpAuth([{ authenticate: async () => ({ userId: 'u1', clientId: 'c1', chave }) }]);
    const p = await auth.authenticate('Bearer tok');
    expect(p).toEqual({ userId: 'u1', cliente: { clientId: 'c1', chave } });
  });

  it('chave de API (sem clientId) não ganha cliente', async () => {
    const auth = new AuthenticatorsMcpAuth([{ authenticate: async () => ({ userId: 'u1' }) }]);
    expect(await auth.authenticate('Bearer tok')).toEqual({ userId: 'u1' });
  });
});
