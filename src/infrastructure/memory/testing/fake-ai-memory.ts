import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';

interface FakeUser {
  id: string;
  username: string;
  name: string | null;
  disabled_at: number | null;
}
interface FakeCredential {
  id: string;
  user_id: string;
  label: string;
  preview: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
  token: string;
}

/** Marcas que nenhum log/erro da ufba.app pode conter. */
export const FAKE_TEMP_PASSWORD = 'CANARIO-temp-password-fake-0001';

/** Ferramentas do /mcp do ai-memory 3.4.6 (spike S5); as de escopo recebem workspace/project no schema. */
export const FAKE_MEMORY_TOOLS: readonly string[] = [
  'memory_briefing', 'memory_explore', 'memory_handoff_list', 'memory_message_list', 'memory_query',
  'memory_read_page', 'memory_read_session_observations', 'memory_recent', 'memory_resolve_write_target',
  'memory_write_page', 'memory_handoff_begin', 'memory_handoff_accept', 'memory_message_send', 'memory_message_pop',
  'memory_patch_page', 'memory_write_pages_batch', 'memory_feedback', 'memory_consolidate',
  'memory_delete_page', 'memory_restore_page', 'memory_forget_sweep', 'memory_handoff_cancel', 'memory_message_cancel',
  'memory_install_self_routing', 'memory_auto_improve', 'memory_lint', 'memory_status',
];

export interface RecordedMcpCall {
  username: string;
  name: string;
  args: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

/**
 * Imita a API de admin do ai-memory 3.4.6 como observada no spike (etapa 0), só o que a ufba.app usa:
 * root-only (`Authorization: Bearer <root>`), 409 em username repetido, `temporary_password` na criação,
 * credenciais com microssegundos, `revoke`/`rotate`, e `disable` que NÃO revoga chaves.
 */
export class FakeAiMemory {
  readonly users: FakeUser[] = [];
  readonly credentials: FakeCredential[] = [];
  readonly grants: { username: string; workspace: string; project: string; level: string }[] = [];
  readonly projects = new Map<string, { workspace_name: string; project_name: string }>();
  readonly requests: RecordedRequest[] = [];
  /** Chamadas `tools/call` recebidas no /mcp (com a chave do usuário). */
  readonly mcpCalls: RecordedMcpCall[] = [];
  /** Nomes de ferramenta do /mcp (troque para simular versão nova do memory). */
  mcpTools: string[] = [...FAKE_MEMORY_TOOLS];
  mcpListCount = 0;
  /** Falha a próxima chamada que casar com `path` (para testar retomada). */
  failNext: { path: RegExp; status: number } | null = null;
  private server?: Server;

  constructor(readonly rootToken: string) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  /** Autentica uma chave de usuário (o que `/identity` ou `/mcp` fariam). */
  authenticate(token: string): FakeUser | null {
    const c = this.credentials.find((x) => x.token === token && !x.revoked_at);
    if (!c) return null;
    c.last_used_at = Date.now() * 1000;
    return this.users.find((u) => u.id === c.user_id) ?? null;
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const method = req.method ?? 'GET';
    if (path === '/mcp') return this.handleMcp(req, res, raw);
    const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    this.requests.push({ method, path, authorization: req.headers.authorization, body });

    if (req.headers.authorization !== `Bearer ${this.rootToken}`) {
      return this.reply(res, 403, { error: 'admin operation is root-only in multi-user mode' });
    }
    if (this.failNext && this.failNext.path.test(path)) {
      const { status } = this.failNext;
      this.failNext = null;
      return this.reply(res, status, { error: `boom ${FAKE_TEMP_PASSWORD}` });
    }
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    const user = (name: string) => this.users.find((u) => u.username === name);

    if (method === 'POST' && path === '/admin/human-users') {
      if (user(body.username)) return this.reply(res, 409, { error: 'username already exists' });
      const u: FakeUser = { id: randomUUID(), username: body.username, name: body.name ?? null, disabled_at: null };
      this.users.push(u);
      return this.reply(res, 200, { user: u, temporary_password: FAKE_TEMP_PASSWORD });
    }
    if (method === 'GET' && path === '/admin/users') return this.reply(res, 200, { users: this.users });
    if (seg[0] === 'admin' && seg[1] === 'users' && seg[2]) {
      const u = user(seg[2]);
      if (!u) return this.reply(res, 404, { error: 'unknown user' });
      if (method === 'PATCH' && seg.length === 3) {
        if ('name' in body) u.name = body.name;
        return this.reply(res, 200, { user: u });
      }
      if (method === 'POST' && seg[3] === 'disable') {
        u.disabled_at = Date.now() * 1000; // NÃO revoga as chaves (spike S2)
        return this.reply(res, 200, { user: u });
      }
      if (method === 'POST' && seg[3] === 'grant') {
        const g = this.grants.find((x) => x.username === u.username && x.workspace === body.workspace && x.project === body.project);
        if (g) g.level = body.level;
        else this.grants.push({ username: u.username, workspace: body.workspace, project: body.project, level: body.level });
        return this.reply(res, 200, { username: u.username, ...body });
      }
      if (method === 'POST' && seg[3] === 'revoke') {
        const i = this.grants.findIndex((x) => x.username === u.username && x.workspace === body.workspace && x.project === body.project);
        if (i >= 0) this.grants.splice(i, 1);
        return this.reply(res, 200, { username: u.username, revoked: i >= 0 });
      }
      if (method === 'GET' && seg[3] === 'grants') {
        return this.reply(res, 200, { grants: this.grants.filter((g) => g.username === u.username) });
      }
    }
    if (method === 'POST' && path === '/admin/api-credentials') {
      const u = user(body.username);
      if (!u) return this.reply(res, 404, { error: 'unknown user' });
      const c = this.mint(u.id, body.label);
      return this.reply(res, 200, { credential: this.meta(c), token: c.token });
    }
    if (method === 'GET' && path === '/admin/api-credentials') {
      return this.reply(res, 200, { credentials: this.credentials.map((c) => this.meta(c)) });
    }
    if (seg[0] === 'admin' && seg[1] === 'api-credentials' && seg[2] && method === 'POST') {
      const c = this.credentials.find((x) => x.id === seg[2]);
      if (!c) return this.reply(res, 404, { error: 'unknown credential' });
      if (seg[3] === 'revoke') {
        c.revoked_at = Date.now() * 1000;
        return this.reply(res, 200, { credential: this.meta(c) });
      }
      if (seg[3] === 'rotate') {
        c.token = `aim_${randomBytes(18).toString('base64url')}`;
        return this.reply(res, 200, { credential: this.meta(c), token: c.token });
      }
    }
    if (method === 'POST' && path === '/admin/projects/access') {
      this.projects.set(`${body.workspace}/${body.project}`, { workspace_name: body.workspace, project_name: body.project });
      return this.reply(res, 200, { ...body, changed: true });
    }
    if (method === 'GET' && path === '/admin/projects') {
      return this.reply(res, 200, { projects: [...this.projects.values()] });
    }
    if (method === 'POST' && path === '/admin/purge-project') {
      if (!(body as unknown as { confirm?: boolean }).confirm) return this.reply(res, 400, { error: 'destructive operation requires confirm=true' });
      this.projects.delete(`${body.workspace}/${body.project}`);
      return this.reply(res, 200, { label: `${body.workspace}/${body.project}` });
    }
    return this.reply(res, 404, { error: 'not found' });
  }

  /** /mcp (JSON-RPC, resposta JSON): só aceita chave de USUÁRIO (`aim_`); a root não vale aqui. */
  private handleMcp(req: IncomingMessage, res: ServerResponse, raw: string): void {
    if (req.method !== 'POST') return this.reply(res, 405, { error: 'method not allowed' });
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const user = this.authenticate(bearer);
    if (!user) return this.reply(res, 401, { error: 'unauthorized' });
    const msg = JSON.parse(raw) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) {
      res.writeHead(202);
      return void res.end();
    }
    const result = (r: unknown) => this.reply(res, 200, { jsonrpc: '2.0', id: msg.id, result: r });
    if (msg.method === 'initialize') {
      return result({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-memory', version: '3.4.6' },
      });
    }
    if (msg.method === 'ping') return result({});
    if (msg.method === 'tools/list') {
      this.mcpListCount++;
      return result({
        tools: this.mcpTools.map((name) => ({
          name,
          description: `fake ${name}`,
          inputSchema: {
            type: 'object',
            properties: name === 'memory_status' ? {} : { workspace: { type: 'string' }, project: { type: 'string' }, path: { type: 'string' } },
          },
          annotations: { readOnlyHint: name === 'memory_install_self_routing' },
        })),
      });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      this.mcpCalls.push({ username: user.username, name, args });
      if (args.project === 'forbidden') {
        return result({
          isError: true,
          content: [{ type: 'text', text: `not authorized for ufba-app/forbidden. ask the server operator to grant you read access` }],
        });
      }
      return result({ content: [{ type: 'text', text: `ok:${name}` }] });
    }
    return this.reply(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }

  private mint(userId: string, label: string): FakeCredential {
    const token = `aim_${randomBytes(18).toString('base64url')}`;
    const c: FakeCredential = {
      id: randomUUID(),
      user_id: userId,
      label,
      preview: `…${token.slice(-4)}`,
      created_at: Date.now() * 1000,
      token,
    };
    this.credentials.push(c);
    return c;
  }

  private meta(c: FakeCredential): Omit<FakeCredential, 'token'> {
    const { token: _t, ...rest } = c;
    void _t;
    return rest;
  }
}
