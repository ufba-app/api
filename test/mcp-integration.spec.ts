import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { IdentityService } from '../src/application/identity/identity.service';
import { OAUTH_STORE, USER_DIRECTORY } from '../src/application/oauth/oauth-ports';
import { OAuthService } from '../src/application/oauth/oauth.service';
import { LiveSources } from '../src/application/ports/live-source';
import {
  ApiKeyRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  UserRepository,
} from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { SecretCipher } from '../src/application/ports/secret-cipher';
import { OAUTH_SERVICE } from '../src/interface/mcp/oauth/oauth.controller';
import { MemoryOAuthStore, MemoryUserDirectory } from '../src/interface/mcp/testing/memory-oauth-store';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { UserPermissionRepository } from '../src/application/ports/permissions';
import { InMemoryPermissions } from './support/permission-fake';
import { MoodleLive } from '../src/infrastructure/sources/moodle/moodle-live';
import { MemorySigaaSessionStore } from '../src/infrastructure/sources/sigaa/memory-session-store';
import { SessoesSigaa } from '../src/infrastructure/sources/sigaa/sessoes-sigaa';
import type { SigaaSession } from '../src/infrastructure/sources/sigaa/session';
import { SigaaLive } from '../src/infrastructure/sources/sigaa/sigaa-live';

/**
 * O AppModule inteiro (rotas, guard, wiring real do MCP/OAuth, MoodleLive real) com repositórios em memória e um
 * Moodle falso por `fetch`: sem banco, sem rede. Conta quantas chamadas cada ferramenta faz ao Moodle.
 */
describe('MCP + OAuth no AppModule (leitura ao vivo)', () => {
  let app: INestApplication;
  let base: string;
  let identity: IdentityService;
  let oauth: OAuthService;
  const keys = new Map<string, { id: string; userId: string }>();
  let userSeq = 0;
  const moodleUsers = new Set<string>();
  const moodleCalls: string[] = [];
  /** SIGAA falso: só conta o que chegaria a ele (login incluído). Nenhum teste aqui deve tocá-lo. */
  const sigaaCalls: string[] = [];
  const fakeSigaa = {
    login: async () => void sigaaCalls.push('login'),
    resume: () => undefined,
    exportCookie: () => Secret.of('JSESSIONID=fake'),
    get: async (path: string) => (sigaaCalls.push(`GET ${path}`), ''),
    postback: async (path: string) => (sigaaCalls.push(`POST ${path}`), ''),
  } as unknown as SigaaSession;

  /** Moodle falso: responde por wsfunction (POST) ou devolve um arquivo (GET pluginfile). */
  const fakeMoodle = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('pluginfile.php')) {
      moodleCalls.push('pluginfile');
      return new Response('conteudo', { headers: { 'content-type': 'text/plain' } });
    }
    const fn = (init?.body as URLSearchParams).get('wsfunction') as string;
    moodleCalls.push(fn);
    const data: Record<string, unknown> = {
      core_course_get_enrolled_courses_by_timeline_classification: {
        courses: [{ id: 10, fullname: 'Tópicos Especiais', shortname: 'MATA99' }],
      },
      core_calendar_get_calendar_upcoming_view: {
        events: [{ id: 1, name: 'Trabalho 1 vence', timestart: 1800000000, modulename: 'assign', course: { id: 10, fullname: 'Tópicos Especiais' } }],
      },
      core_course_get_contents: [
        {
          id: 1,
          name: 'Semana 1',
          modules: [
            {
              id: 501,
              name: 'Trabalho 1',
              modname: 'assign',
              url: 'https://ava.test/mod/assign/view.php?id=501',
            },
          ],
        },
      ],
      mod_assign_get_assignments: {
        courses: [
          {
            id: 10,
            assignments: [
              {
                id: 7,
                cmid: 501,
                name: 'Trabalho 1',
                intro: '<p>Entregar o <b>relatório</b></p>',
                duedate: 1800000000,
                introattachments: [{ filename: 'enunciado.txt', fileurl: 'https://ava.test/webservice/pluginfile.php/9/enunciado.txt' }],
              },
            ],
          },
        ],
      },
    };
    return new Response(JSON.stringify(data[fn] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;

  const contasMoodle = (userId: string): SourceAccountRecord[] =>
    moodleUsers.has(userId)
      ? [
          {
            id: `acc-${userId}`,
            userId,
            provider: 'MOODLE',
            accountKey: 'ava.test:aluno',
            siteUrl: 'https://ava.test',
            status: 'OK',
            lastSyncedAt: null,
            secret: { ciphertext: 'WSTOKEN', iv: 'i', authTag: 't' },
          },
        ]
      : [];

  beforeAll(async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.OAUTH_AUTHORIZE_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    const { AppModule } = await import('../src/app.module');

    const live = new LiveSources();
    live.register(new MoodleLive(fakeMoodle));
    live.register(
      new SigaaLive(
        new SessoesSigaa(
          () => fakeSigaa,
          new MemorySigaaSessionStore(),
          { encrypt: (s: string) => ({ ciphertext: s, iv: 'i', authTag: 't' }), decrypt: (e: { ciphertext: string }) => e.ciphertext } as never,
        ),
      ),
    );

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(UserPermissionRepository)
      .useValue(new InMemoryPermissions())
      .overrideProvider(LiveSources)
      .useValue(live)
      .overrideProvider(SecretCipher)
      .useValue({ encrypt: (p: string) => ({ ciphertext: p, iv: 'i', authTag: 't' }), decrypt: (s: { ciphertext: string }) => s.ciphertext })
      .overrideProvider(OAUTH_STORE)
      .useValue(new MemoryOAuthStore())
      .overrideProvider(USER_DIRECTORY)
      .useValue(new MemoryUserDirectory())
      .overrideProvider(UserRepository)
      .useValue({ create: async () => ({ id: `user-${++userSeq}`, name: null, createdAt: new Date() }) })
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
      .useValue({
        findByUserAndProvider: async (userId: string, provider: string): Promise<SourceAccountRecord[]> =>
          provider === 'MOODLE' ? contasMoodle(userId) : [],
        listByUser: async (userId: string) => contasMoodle(userId),
        setStatus: async () => undefined,
      })
      .compile();

    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    identity = mod.get(IdentityService);
    oauth = mod.get(OAUTH_SERVICE);
  });

  afterAll(() => app.close());
  beforeEach(() => (moodleCalls.length = 0));

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

  /** Usuário novo com Moodle conectado; devolve a chave de API. */
  async function alunoComMoodle(): Promise<string> {
    const { apiKey, userId } = (await identity.criarUsuario({})) as { apiKey: string; userId: string };
    moodleUsers.add(userId);
    return apiKey;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (r: any) => JSON.parse((r.content as { text: string }[])[0].text);

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
      const res = await fetch(`${base}/fontes`, { headers: { authorization: 'Bearer qualquer-coisa' } });
      expect(res.status).toBe(401);
    });
  });

  describe('credenciais válidas', () => {
    it('chave de API (plt_) abre o /mcp', async () => {
      const { apiKey } = await identity.criarUsuario({ name: 'x' });
      expect(apiKey).toMatch(/^plt_/);
      expect((await rpc(apiKey)).status).toBe(200);
    });

    it('token OAuth abre o /mcp e o REST', async () => {
      const token = await oauthToken();
      expect((await rpc(token)).status).toBe(200);
      const rest = await fetch(`${base}/fontes`, { headers: { authorization: `Bearer ${token}` } });
      expect(rest.status).toBe(200);
    });
  });

  describe('leitura ao vivo: cada ferramenta faz só as chamadas da pergunta', () => {
    it('listar_contas: mostra as contas conectadas sem chamar fonte nenhuma', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({ name: 'listar_contas', arguments: {} });
      expect(text(r).contas).toEqual([{ fonte: 'moodle', conta: expect.any(String) }]);
      expect(moodleCalls).toEqual([]);
      await client.close();
    });

    it('conta inexistente: erro claro, nenhuma chamada', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({ name: 'listar_cursos', arguments: { conta: 'outra:conta' } });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0].text).toContain('não está conectada');
      expect(moodleCalls).toEqual([]);
      await client.close();
    });

    it('listar_cursos: 1 chamada, só os cursos em andamento', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({ name: 'listar_cursos', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r).cursos).toEqual([{ id: '10', nome: 'Tópicos Especiais', codigo: 'MATA99' }]);
      expect(moodleCalls).toEqual(['core_course_get_enrolled_courses_by_timeline_classification']);
      await client.close();
    });

    it('prazos: 1 chamada ao calendário, sem entrar em curso nenhum', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({ name: 'prazos', arguments: {} });
      expect(text(r).prazos[0]).toMatchObject({ titulo: 'Trabalho 1 vence', cursoId: '10', tipo: 'tarefa' });
      expect(moodleCalls).toEqual(['core_calendar_get_calendar_upcoming_view']);
      await client.close();
    });

    it('ver_curso: 2 chamadas, tarefa com descrição em texto, prazo e anexo', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({ name: 'ver_curso', arguments: { cursoId: '10' } });
      const [t] = text(r).atividades;
      expect(t).toMatchObject({ id: '501', tipo: 'tarefa', titulo: 'Trabalho 1', descricao: 'Entregar o relatório' });
      expect(t.prazo).toBe(new Date(1800000000 * 1000).toISOString());
      expect(t.anexos[0]).toMatchObject({ nome: 'enunciado.txt' });
      expect(t.anexos[0].ref).not.toContain('token=');
      expect(moodleCalls.sort()).toEqual(['core_course_get_contents', 'mod_assign_get_assignments']);
      await client.close();
    });

    it('baixar_anexo: devolve link sem tocar o Moodle; o link baixa uma vez', async () => {
      const client = await clientWith(await alunoComMoodle());
      const r = await client.callTool({
        name: 'baixar_anexo',
        arguments: { ref: 'https://ava.test/webservice/pluginfile.php/9/enunciado.txt', nome: 'enunciado.txt' },
      });
      const { link, comoBaixar } = text(r);
      expect(link).toMatch(new RegExp(`^${base}/download/`));
      expect(comoBaixar).toContain('curl');
      expect(moodleCalls).toEqual([]);

      const dl = await fetch(link);
      expect(dl.status).toBe(200);
      expect(await dl.text()).toBe('conteudo');
      expect(moodleCalls).toEqual(['pluginfile']);
      expect((await fetch(link)).status).toBe(404);
      await client.close();
    });

    it('sem Moodle conectado: erro claro, nenhuma chamada', async () => {
      const { apiKey } = await identity.criarUsuario({});
      const client = await clientWith(apiKey as string);
      const r = await client.callTool({ name: 'prazos', arguments: {} });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0].text).toContain('não conectado');
      expect(moodleCalls).toEqual([]);
      await client.close();
    });

    it('fonte sigaa sem chave no token: erro claro e zero requisições ao SIGAA', async () => {
      sigaaCalls.length = 0;
      // Chave de API (sem cliente) e token OAuth emitido sem SIGAA conectado (sem K): nenhum dos dois abre o SIGAA.
      for (const token of [await alunoComMoodle(), await oauthToken()]) {
        const client = await clientWith(token);
        for (const [name, args] of [
          ['listar_cursos', {}],
          ['prazos', {}],
          ['ver_curso', { cursoId: 'sistemas-operacionais' }],
          ['ver_aviso', { avisoId: 'sistemas-operacionais:1' }],
        ] as const) {
          const r = await client.callTool({ name, arguments: { fonte: 'sigaa', ...args } });
          expect(r.isError).toBe(true);
          expect((r.content as { text: string }[])[0].text).toContain('SIGAA não conectado');
        }
        const contas = await client.callTool({ name: 'listar_contas', arguments: {} });
        expect(JSON.stringify(text(contas))).not.toContain('sigaa');
        await client.close();
      }
      expect(sigaaCalls).toEqual([]);
      expect(moodleCalls).toEqual([]);
    });

    it('não existe ferramenta de sincronização nem de leitura de banco', async () => {
      const client = await clientWith(await alunoComMoodle());
      const { tools } = await client.listTools();
      const nomes = tools.map((t) => t.name);
      for (const velho of ['sincronizar', 'listar_itens', 'agenda', 'mudancas', 'perfil', 'historico', 'insights', 'importar_historico', 'ler_anexo']) {
        expect(nomes).not.toContain(velho);
      }
      await client.close();
    });
  });
});
