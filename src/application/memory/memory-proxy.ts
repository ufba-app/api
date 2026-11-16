import { Injectable, Logger } from '@nestjs/common';
import type { Secret } from '../shared/secret';
import { decorateTool } from './memory-tool-meta';
import { connectComputerGuide, HINT_NO_COMPUTER_CONDITIONAL, HINT_NO_COMPUTER_WEB, isWebChatClient, MEMORY_CONNECT_TOOL } from './connect-guide';
import { MemoryComputerDirectory } from './device-ports';
import {
  MemoryAccess,
  MemoryAdmin,
  MemoryAdminError,
  MemoryMcp,
  MemoryProjectRegistry,
  RemoteTool,
  RemoteToolResult,
} from './memory-ports';
import { isForwardable } from './memory-tool-policy';
import { MemoryUsers } from './memory-users';
import { MemoryGrantSync } from './project-ports';
import { RateWindow } from './rate-window';

/** Quem chama o MCP (`clientInfo.name` do `initialize`); ausente = desconhecido. */
export interface MemoryClient {
  name?: string | null;
}

export const MEMORY_INSTRUCTIONS =
  'Este servidor também dá acesso à memória compartilhada da equipe (ferramentas `memory_*`). Sempre informe ' +
  '`workspace` e `project` explicitamente. A memória guarda o que você escreve; nunca grave senhas, tokens ou dados ' +
  'pessoais de outras pessoas. Existe captura automática das sessões quando o computador da pessoa está conectado e o ' +
  'repositório tem um `.ai-memory.toml` (sem ele, nada é capturado). Chame `memory_status` no começo de uma conversa ' +
  'em que a memória seja relevante. Só se você roda num terminal ou editor com acesso ao computador da pessoa E ela quiser ' +
  'a captura automática, e não houver computador conectado, ofereça `memory_connect_computer`; num chat web, não ' +
  'mencione a conexão de computador. Nunca execute comandos de instalação sem pedir permissão antes.';

/** Para cliente de chat web/desktop (sem terminal): nada de oferta de conectar computador. */
export const MEMORY_INSTRUCTIONS_WEB =
  'Este servidor também dá acesso à memória compartilhada da equipe (ferramentas `memory_*`). Sempre informe ' +
  '`workspace` e `project` explicitamente. A memória guarda o que você escreve; nunca grave senhas, tokens ou dados ' +
  'pessoais de outras pessoas. Chame `memory_status` no começo de uma conversa em que a memória seja relevante.';

/** As instruções certas para o cliente (`clientInfo.name`); sem nome (desconhecido) vale o texto condicional. */
export const memoryInstructionsFor = (clientName?: string | null): string =>
  isWebChatClient(clientName) ? MEMORY_INSTRUCTIONS_WEB : MEMORY_INSTRUCTIONS;

export const MAX_BODY_BYTES = 1024 * 1024;
export const CALLS_PER_MINUTE = 30;
export const CATALOG_TTL_MS = 5 * 60_000;

export const MEMORY_STATUS_TOOL: RemoteTool = {
  name: 'memory_status',
  description:
    'Estado da memória compartilhada para esta pessoa: se o servidor de memória está no ar, se a conta dela está ' +
    'pronta e quais computadores estão conectados (nome e último uso). Lê do servidor; não recebe parâmetros.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const MSG = {
  unavailable: 'A memória está indisponível no momento. Tente de novo em instantes.',
  refused: 'A chave de memória desta conta foi recusada. Fale com a equipe da ufba.app.',
  notAllowed: 'A memória compartilhada não está liberada para esta conta.',
  tooBig: 'A chamada passa de 1 MB. Divida o conteúdo em partes menores.',
  rate: 'Muitas chamadas de memória em pouco tempo (limite: 30 por minuto). Aguarde um instante.',
  scope: 'Informe `workspace` e `project` (texto) explicitamente; não use `workspace_id` nem `project_id`.',
} as const;

function failure(text: string): RemoteToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function ok(value: unknown): RemoteToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function shown(v: string): string {
  return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
}

function hasScope(tool: RemoteTool): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'workspace' in props || 'project' in props;
}

export interface ProxyOptions {
  now?: () => number;
  callsPerMinute?: number;
  /** Reconciliador de acessos, chamado no máximo a cada 5 min por pessoa (convites e papéis valem no primeiro uso). */
  sync?: MemoryGrantSync;
  /** Origem do painel (`WEB_ORIGIN`), para o link de computadores do guia de conexão. */
  webOrigin?: () => string;
}

const SYNC_EVERY_MS = 5 * 60_000;

/**
 * Proxy das ferramentas `memory_*`: lista de permissão por nome, escopo explícito e registrado, limites e chave de
 * repasse da pessoa. Não altera argumentos nem resultado das ferramentas repassadas. Nunca devolve corpo de erro do
 * memory (só mensagens fixas).
 */
@Injectable()
export class MemoryProxy {
  private catalog: { tools: RemoteTool[]; at: number } | null = null;
  private readonly rate: RateWindow;
  private readonly now: () => number;
  private readonly grants?: MemoryGrantSync;
  private readonly syncedAt = new Map<string, number>();
  private readonly webOrigin: () => string;
  private readonly warnedAt = new Map<string, number>();
  private readonly log = new Logger('MemoryProxy');

  constructor(
    private readonly admin: MemoryAdmin,
    private readonly users: MemoryUsers,
    private readonly mcp: MemoryMcp,
    private readonly registry: MemoryProjectRegistry,
    private readonly access: MemoryAccess,
    private readonly computers: MemoryComputerDirectory,
    opts: ProxyOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.grants = opts.sync;
    this.webOrigin = opts.webOrigin ?? (() => 'http://localhost:3001');
    this.rate = new RateWindow(opts.callsPerMinute ?? CALLS_PER_MINUTE, 60_000, this.now);
  }

  enabled(): boolean {
    return this.admin.isConfigured();
  }

  /** `memory_status` sempre (quando liberado) + as do memory que passam no filtro. Memory fora do ar: só a da casa. */
  async listTools(userId: string, client?: MemoryClient): Promise<RemoteTool[]> {
    if (!this.enabled() || !(await this.access.canUse(userId))) return [];
    // Chat web não tem terminal: a ferramenta de conectar computador nem aparece.
    const own = (isWebChatClient(client?.name) ? [MEMORY_STATUS_TOOL] : [MEMORY_STATUS_TOOL, MEMORY_CONNECT_TOOL]).map(decorateTool);
    try {
      await this.users.ensure(userId);
      await this.syncGrants(userId);
      return [...own, ...(await this.remoteTools(userId))];
    } catch {
      return own;
    }
  }

  /** `null` quando o nome não é de memória (o chamador segue para as ferramentas da casa). */
  async call(
    userId: string,
    name: string,
    args: Record<string, unknown> = {},
    client?: MemoryClient,
  ): Promise<RemoteToolResult | null> {
    if (!name.startsWith('memory_')) return null;
    const web = isWebChatClient(client?.name);
    if (!this.enabled()) return failure(MSG.unavailable);
    if (name !== 'memory_status' && name !== MEMORY_CONNECT_TOOL.name && !isForwardable(name)) {
      return failure(`A ferramenta ${name} não está disponível neste servidor.`);
    }
    if (!(await this.access.canUse(userId))) return failure(MSG.notAllowed);
    if (name === MEMORY_CONNECT_TOOL.name && web) return failure(`A ferramenta ${name} não está disponível neste cliente.`);
    // Só texto: não fala com o memory nem cria usuário (funciona mesmo com o memory fora do ar).
    if (name === MEMORY_CONNECT_TOOL.name) return { content: [{ type: 'text', text: connectComputerGuide(args.os, this.webOrigin()) }] };
    try {
      await this.users.ensure(userId);
      await this.syncGrants(userId);
      return name === 'memory_status' ? await this.status(userId, web) : await this.forward(userId, name, args);
    } catch (e) {
      if (name === 'memory_status') return this.statusDown();
      return failure(e instanceof MemoryAdminError && e.kind === 'forbidden' ? MSG.refused : MSG.unavailable);
    }
  }

  /** Alerta de limite: só ids e nome da ferramenta (nunca argumentos), no máximo um por pessoa a cada 10 min. */
  private warnLimit(userId: string, tool: string): void {
    const t = this.now();
    const last = this.warnedAt.get(userId);
    if (last !== undefined && t - last < 10 * 60_000) return;
    this.warnedAt.set(userId, t);
    this.log.warn(`limite de chamadas de memória atingido: user=${userId} tool=${tool}`);
  }

  /** Põe os acessos em dia (convites aceitos, papéis novos) sem travar a chamada se o reconciliador falhar. */
  private async syncGrants(userId: string): Promise<void> {
    if (!this.grants) return;
    const t = this.now();
    const last = this.syncedAt.get(userId);
    if (last !== undefined && t - last < SYNC_EVERY_MS) return;
    this.syncedAt.set(userId, t);
    await this.grants.syncUser(userId).catch(() => undefined);
  }

  private async forward(userId: string, name: string, args: Record<string, unknown>): Promise<RemoteToolResult> {
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_BODY_BYTES) return failure(MSG.tooBig);
    if (!this.rate.take(userId)) {
      this.warnLimit(userId, name);
      return failure(MSG.rate);
    }
    const key = await this.users.proxyKey(userId);
    const tool = (await this.remoteTools(userId, key)).find((t) => t.name === name);
    if (!tool) return failure(`A ferramenta ${name} não existe neste servidor de memória.`);
    if (hasScope(tool)) {
      const scoped = await this.checkScope(args);
      if (scoped) return scoped;
    }
    return this.mcp.callTool(key, name, args);
  }

  /** Workspace e projeto explícitos e registrados (S12); `*_id` não vale (endereçaria um projeto fora do registro). */
  private async checkScope(args: Record<string, unknown>): Promise<RemoteToolResult | null> {
    const { workspace, project } = args;
    if ('workspace_id' in args || 'project_id' in args) return failure(MSG.scope);
    if (typeof workspace !== 'string' || typeof project !== 'string' || !workspace || !project) {
      return failure(MSG.scope);
    }
    if (!(await this.registry.isRegistered(workspace, project))) {
      return failure(`O projeto ${shown(`${workspace}/${project}`)} não está registrado na memória da ufba.app.`);
    }
    return null;
  }

  private async remoteTools(userId: string, key?: Secret): Promise<RemoteTool[]> {
    const t = this.now();
    if (this.catalog && t - this.catalog.at < CATALOG_TTL_MS) return this.catalog.tools;
    const all = await this.mcp.listTools(key ?? (await this.users.proxyKey(userId)));
    // Schema com type em tudo, title e annotations da casa (exigências da loja); argumentos e resultados seguem intactos.
    const tools = all.filter((x) => isForwardable(x.name)).map(decorateTool);
    this.catalog = { tools, at: t };
    return tools;
  }

  private async status(userId: string, web = false): Promise<RemoteToolResult> {
    await this.users.ensure(userId);
    if (!(await this.admin.ping())) return this.statusDown();
    const computers = (await this.computers.active(userId)).map((c) => ({
      name: c.name,
      os: c.os,
      last_seen: c.lastSeen ? c.lastSeen.toISOString() : null,
    }));
    return ok({
      memory_available: true,
      user_ready: true,
      connected_computers: computers,
      hint: computers.length
        ? 'Há computador conectado.'
        : web
          ? HINT_NO_COMPUTER_WEB
          : HINT_NO_COMPUTER_CONDITIONAL,
    });
  }

  private statusDown(): RemoteToolResult {
    return ok({
      memory_available: false,
      user_ready: false,
      connected_computers: [],
      hint: 'O servidor de memória está indisponível agora. As ferramentas memory_* voltam quando ele voltar.',
    });
  }
}
