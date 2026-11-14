import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  GrantLevel,
  IssuedCredential,
  MemoryAdmin,
  MemoryAdminError,
  MemoryCredential,
  MemoryGrant,
  MemoryProjectInfo,
  MemoryUserInfo,
  ProjectAccessMode,
} from '../../application/memory/memory-ports';
import { Secret } from '../../application/shared/secret';

export const DEFAULT_MEMORY_URL = 'https://memory.ufba.app';
const TIMEOUT_MS = 10_000;

const credentialSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  label: z.string(),
  preview: z.string().optional().default(''),
  created_at: z.number(),
  last_used_at: z.number().nullish(),
  revoked_at: z.number().nullish(),
});
const issuedSchema = z.object({ credential: credentialSchema, token: z.string().min(1) });
const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().nullish(),
  disabled_at: z.number().nullish(),
});
const grantSchema = z.object({
  username: z.string(),
  workspace: z.string(),
  project: z.string(),
  level: z.enum(['read', 'write']),
});

/** O ai-memory manda microssegundos desde a época. */
const fromMicros = (n: number): Date => new Date(Math.floor(n / 1000));

function toCredential(c: z.infer<typeof credentialSchema>): MemoryCredential {
  return {
    id: c.id,
    memoryUserId: c.user_id,
    label: c.label,
    preview: c.preview,
    createdAt: fromMicros(c.created_at),
    lastUsedAt: c.last_used_at ? fromMicros(c.last_used_at) : null,
    revokedAt: c.revoked_at ? fromMicros(c.revoked_at) : null,
  };
}

function toIssued(raw: unknown): IssuedCredential {
  const parsed = issuedSchema.parse(raw);
  return { credential: toCredential(parsed.credential), token: Secret.of(parsed.token) };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** https obrigatório (http só em loopback, para testes) e nunca um domínio `*.up.railway.app`. */
export function validateMemoryUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('MEMORY_URL deve ser https (http só em loopback).');
  }
  if (url.hostname.endsWith('.up.railway.app')) {
    throw new Error('MEMORY_URL deve ser a URL pública do memory, não *.up.railway.app.');
  }
  return url;
}

export interface MemoryAdminClientOptions {
  baseUrl?: string;
  rootToken?: Secret;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Cliente HTTP da API administrativa do ai-memory. O token root vive só aqui (`reveal()` no cabeçalho). Erros nunca
 * levam o corpo da resposta (pode ter senha temporária, chave ou conteúdo): só `kind` e status.
 */
@Injectable()
export class MemoryAdminClient extends MemoryAdmin {
  private readonly base: URL;
  private readonly root?: Secret;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: MemoryAdminClientOptions = {}) {
    super();
    this.base = validateMemoryUrl(opts.baseUrl ?? DEFAULT_MEMORY_URL);
    this.root = opts.rootToken && !opts.rootToken.isEmpty() ? opts.rootToken : undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MemoryAdminClient {
    return new MemoryAdminClient({
      baseUrl: env.MEMORY_URL || DEFAULT_MEMORY_URL,
      rootToken: env.MEMORY_ROOT_TOKEN ? Secret.of(env.MEMORY_ROOT_TOKEN) : undefined,
    });
  }

  isConfigured(): boolean {
    return this.root !== undefined;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(new URL('/healthz', this.base), {
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createHumanUser(input: { username: string; name?: string }): Promise<{ created: boolean }> {
    try {
      // A resposta tem `temporary_password`: nem é lida.
      await this.call('POST', '/admin/human-users', { username: input.username, name: input.name });
      return { created: true };
    } catch (e) {
      if (e instanceof MemoryAdminError && e.kind === 'conflict') return { created: false };
      throw e;
    }
  }

  async findUser(username: string): Promise<MemoryUserInfo | null> {
    const raw = await this.call('GET', '/admin/users');
    const users = z.object({ users: z.array(userSchema) }).parse(raw).users;
    const u = users.find((x) => x.username === username);
    return u ? { id: u.id, username: u.username, name: u.name ?? null, disabled: Boolean(u.disabled_at) } : null;
  }

  async renameUser(username: string, name: string): Promise<void> {
    await this.call('PATCH', `/admin/users/${encodeURIComponent(username)}`, { name });
  }

  async disableUser(username: string): Promise<void> {
    await this.call('POST', `/admin/users/${encodeURIComponent(username)}/disable`);
  }

  async issueCredential(username: string, label: string): Promise<IssuedCredential> {
    return toIssued(await this.call('POST', '/admin/api-credentials', { username, label }));
  }

  async rotateCredential(credentialId: string): Promise<IssuedCredential> {
    return toIssued(await this.call('POST', `/admin/api-credentials/${encodeURIComponent(credentialId)}/rotate`));
  }

  async revokeCredential(credentialId: string): Promise<void> {
    await this.call('POST', `/admin/api-credentials/${encodeURIComponent(credentialId)}/revoke`);
  }

  async listCredentials(username: string): Promise<MemoryCredential[]> {
    const user = await this.findUser(username);
    if (!user) return [];
    const raw = await this.call('GET', '/admin/api-credentials');
    return z
      .object({ credentials: z.array(credentialSchema) })
      .parse(raw)
      .credentials.filter((c) => c.user_id === user.id)
      .map(toCredential);
  }

  async setProjectAccess(workspace: string, project: string, mode: ProjectAccessMode): Promise<void> {
    await this.call('POST', '/admin/projects/access', { workspace, project, mode });
  }

  async grant(username: string, workspace: string, project: string, level: GrantLevel): Promise<void> {
    await this.call('POST', `/admin/users/${encodeURIComponent(username)}/grant`, { workspace, project, level });
  }

  async revokeGrant(username: string, workspace: string, project: string): Promise<void> {
    await this.call('POST', `/admin/users/${encodeURIComponent(username)}/revoke`, { workspace, project });
  }

  async listGrants(username: string): Promise<MemoryGrant[]> {
    const raw = await this.call('GET', `/admin/users/${encodeURIComponent(username)}/grants`);
    return z.object({ grants: z.array(grantSchema) }).parse(raw).grants;
  }

  async listProjects(): Promise<MemoryProjectInfo[]> {
    const raw = await this.call('GET', '/admin/projects');
    return z
      .object({ projects: z.array(z.object({ workspace_name: z.string(), project_name: z.string() })) })
      .parse(raw)
      .projects.map((p) => ({ workspace: p.workspace_name, project: p.project_name }));
  }

  async purgeProject(workspace: string, project: string): Promise<void> {
    await this.call('POST', '/admin/purge-project', { workspace, project, confirm: true });
  }

  /** Única saída HTTP: caminho fixo (montado acima), token root no cabeçalho, erros sem corpo. */
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.root) throw new MemoryAdminError('unavailable');
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.base), {
        method,
        headers: {
          authorization: `Bearer ${this.root.reveal()}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Descarta a causa: a mensagem do fetch pode incluir URL e cabeçalhos.
      throw new MemoryAdminError('unavailable');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new MemoryAdminError(kindOf(res.status), res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new MemoryAdminError('unavailable', res.status);
    }
  }
}

function kindOf(status: number): MemoryAdminError['kind'] {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 400 || status === 422) return 'rejected';
  return 'unavailable';
}
