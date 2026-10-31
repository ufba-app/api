import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { IdentityService } from '../src/application/identity/identity.service';
import { OAUTH_STORE, USER_DIRECTORY } from '../src/application/oauth/oauth-ports';
import { OAuthService } from '../src/application/oauth/oauth.service';
import { TranscriptSource } from '../src/application/ports/academic-ports';
import {
  ApiKeyRepository,
  ReadRepository,
  SourceAccountRepository,
  UserRepository,
} from '../src/application/ports/repositories';
import {
  SourceGateway,
  SourceRegistry,
  type Provider,
} from '../src/application/ports/source-gateway';
import { OAUTH_SERVICE } from '../src/interface/mcp/oauth/oauth.controller';
import {
  MemoryOAuthStore,
  MemoryUserDirectory,
} from '../src/interface/mcp/testing/memory-oauth-store';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';

/** O AppModule inteiro (rotas, guard, wiring real do MCP/OAuth) com repositórios em memória: sem banco, sem rede. */
describe('MCP + OAuth no AppModule', () => {
  let app: INestApplication;
  let base: string;
  let identity: IdentityService;
  let oauth: OAuthService;
  const fetchSpy = jest.fn();
  const pdfSpy = jest.fn();
  const keys = new Map<string, { id: string; userId: string }>();

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.OAUTH_AUTHORIZE_SECRET;
    const { AppModule } = await import('../src/app.module');

    const registry = new SourceRegistry();
    for (const provider of ['SIGAA', 'MOODLE', 'CLASSROOM', 'CALENDAR'] as Provider[]) {
      const g: SourceGateway = {
        provider,
        auth: provider === 'SIGAA' ? 'segredo-por-requisicao' : 'token-guardado',
        fetch: async (...args) => {
          fetchSpy(provider, args);
          return {};
        },
      };
      registry.register(g);
    }

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SourceRegistry)
      .useValue(registry)
      .overrideProvider(TranscriptSource)
      .useValue({ fetchTranscriptPdf: pdfSpy })
      .overrideProvider(OAUTH_STORE)
      .useValue(new MemoryOAuthStore())
      .overrideProvider(USER_DIRECTORY)
      .useValue(new MemoryUserDirectory())
      .overrideProvider(UserRepository)
      .useValue({ create: async () => ({ id: 'user-1', name: null, createdAt: new Date() }) })
      .overrideProvider(ApiKeyRepository)
      .useValue({
        create: async (i: { userId: string; keyHash: string }) => {
          const rec = { id: `k${keys.size}`, userId: i.userId };
          keys.set(i.keyHash, rec);
          return rec;
        },
        findActiveByHash: async (h: string) => keys.get(h) ?? null,
        touch: async () => undefined,
      })
      .overrideProvider(SourceAccountRepository)
      .useValue({ listByUser: async () => [] })
      .overrideProvider(ReadRepository)
      .useValue({
        listCourseSpaces: async () => [],
        listItems: async () => [],
        listEvents: async () => [],
        listChanges: async () => [],
        getProfile: async () => null,
        getTranscript: async () => null,
      })
      .compile();

    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    identity = mod.get(IdentityService);
    oauth = mod.get(OAUTH_SERVICE);
  });

  afterAll(() => app.close());
  beforeEach(() => {
    fetchSpy.mockClear();
    pdfSpy.mockClear();
  });

  const rpc = (token?: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  async function clientWith(token: string): Promise<Client> {
    const client = new Client({ name: 'teste', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  async function oauthToken(): Promise<string> {
    const verifier = 'v'.repeat(60);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = 'http://localhost:7777/cb';
    const c = await oauth.registerClient({ redirect_uris: [redirect] });
    const p = await oauth.begin({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await oauth.identify(p.id, 'aluno@example.com');
    const code = new URL(await oauth.complete(p.id)).searchParams.get('code') as string;
    const t = await oauth.token({
      grant_type: 'authorization_code',
      code,
      client_id: c.clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    return t.access_token;
  }

  describe('Bearer inválido leva 401 (nenhum stub de auth sobra)', () => {
    it('sem Bearer', async () => {
      expect((await rpc()).status).toBe(401);
    });

    it('Bearer que não é chave nem token OAuth', async () => {
      const res = await rpc('qualquer-coisa');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    });

    it('chave com prefixo plt_ que não existe', async () => {
      expect((await rpc('plt_naoexiste')).status).toBe(401);
    });

    it('o REST também recusa', async () => {
      const res = await fetch(`${base}/perfil`, { headers: { authorization: 'Bearer qualquer-coisa' } });
      expect(res.status).toBe(401);
    });
  });

  describe('credenciais válidas', () => {
    it('chave de API (plt_) abre o /mcp', async () => {
      const { apiKey } = await identity.criarUsuario({ name: 'x' });
      expect(apiKey).toMatch(/^plt_/);
      const res = await rpc(apiKey);
      expect(res.status).toBe(200);
    });

    it('token OAuth abre o /mcp e o REST', async () => {
      const token = await oauthToken();
      expect((await rpc(token)).status).toBe(200);
      const rest = await fetch(`${base}/perfil`, { headers: { authorization: `Bearer ${token}` } });
      expect(rest.status).toBe(200);
    });
  });

  describe('leituras pelo MCP, com os casos de uso reais', () => {
    it.each([
      ['listar_itens', {}],
      ['agenda', {}],
      ['mudancas', {}],
      ['perfil', {}],
      ['historico', {}],
      ['insights', { tipo: 'cr' }],
      ['insights', { tipo: 'trajetoria' }],
      ['insights', { tipo: 'pendentes' }],
    ])('%s %j não chama gateway de fonte nem o SIGAA', async (nome, args) => {
      const { apiKey } = await identity.criarUsuario({});
      const client = await clientWith(apiKey as string);
      const res = await client.callTool({ name: nome, arguments: args });
      expect(res.isError).toBeFalsy();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(pdfSpy).not.toHaveBeenCalled();
      await client.close();
    });

    it('sincronizar é o que chega ao gateway', async () => {
      const { apiKey } = await identity.criarUsuario({});
      const client = await clientWith(apiKey as string);
      // Conta do Moodle inexistente: falha antes de ir à fonte, com erro claro (não quebra o servidor).
      const res = await client.callTool({
        name: 'sincronizar',
        arguments: { fonte: 'moodle', alcance: 'tudo' },
      });
      expect(res.isError).toBe(true);
      await client.close();
    });
  });
});
