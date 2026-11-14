import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MemoryAdminError, MemoryMcp, RemoteTool, RemoteToolResult } from '../../application/memory/memory-ports';
import type { Secret } from '../../application/shared/secret';
import { DEFAULT_MEMORY_URL, validateMemoryUrl } from './memory-admin.client';

const TIMEOUT_MS = 30_000;

export interface MemoryMcpClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Cliente do /mcp do ai-memory com a chave da pessoa. Sem sessão: abre, faz uma chamada e fecha (a ufba.app é sem
 * estado). Qualquer falha vira `MemoryAdminError` sem mensagem do servidor (pode ter conteúdo de trabalho ou segredo).
 */
@Injectable()
export class MemoryMcpClient extends MemoryMcp {
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(opts: MemoryMcpClientOptions = {}) {
    super();
    this.url = new URL('/mcp', validateMemoryUrl(opts.baseUrl ?? DEFAULT_MEMORY_URL));
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MemoryMcpClient {
    return new MemoryMcpClient({ baseUrl: env.MEMORY_URL || DEFAULT_MEMORY_URL });
  }

  async listTools(key: Secret): Promise<RemoteTool[]> {
    return this.session(key, async (c) => {
      const out: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await c.listTools(cursor ? { cursor } : undefined, { timeout: this.timeoutMs });
        out.push(...(res.tools as RemoteTool[]));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return out;
    });
  }

  async callTool(key: Secret, name: string, args: Record<string, unknown>): Promise<RemoteToolResult> {
    return this.session(key, async (c) => {
      const res = await c.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      return res as unknown as RemoteToolResult;
    });
  }

  private async session<T>(key: Secret, fn: (c: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: { headers: { authorization: `Bearer ${key.reveal()}` }, redirect: 'error' },
    });
    const client = new Client({ name: 'ufba-app', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      return await fn(client);
    } catch (e) {
      throw new MemoryAdminError(kindOf(e));
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function kindOf(e: unknown): 'forbidden' | 'unavailable' {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 401 || code === 403 ? 'forbidden' : 'unavailable';
}
