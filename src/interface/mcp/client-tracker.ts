import { createHash } from 'node:crypto';

const TTL_MS = 24 * 60 * 60_000;
const MAX = 5_000;

/**
 * O `/mcp` é sem sessão (um servidor por requisição), mas o `clientInfo.name` só vem no `initialize`. O tracker o guarda
 * por TOKEN (só o hash do Bearer, nunca o token) por 24 h, para as requisições seguintes (`tools/list`, `tools/call`) saberem
 * quem chama. Em memória e por processo (a API roda em uma instância, como o RateWindow do resto da casa); sem registro
 * (reinício, token novo) o cliente é "desconhecido" e vale o texto condicional.
 */
export class McpClientTracker {
  private readonly seen = new Map<string, { name: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(authorization: string | undefined): string | null {
    const m = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
    return m ? createHash('sha256').update(m[1]!).digest('hex') : null;
  }

  /** Lê o nome do `initialize` do corpo JSON-RPC (objeto ou lote); `undefined` se não houver. */
  static fromBody(body: unknown): string | undefined {
    const calls = Array.isArray(body) ? body : [body];
    for (const c of calls) {
      if (!c || typeof c !== 'object') continue;
      const call = c as { method?: unknown; params?: { clientInfo?: { name?: unknown } } };
      const name = call.method === 'initialize' ? call.params?.clientInfo?.name : undefined;
      if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 100);
    }
    return undefined;
  }

  /** O nome de quem chama: o do `initialize` desta requisição (e guarda), ou o guardado para este token. */
  resolve(authorization: string | undefined, body: unknown): string | undefined {
    const key = this.key(authorization);
    if (!key) return undefined;
    const t = this.now();
    const fresh = McpClientTracker.fromBody(body);
    if (fresh) {
      this.seen.set(key, { name: fresh, at: t });
      if (this.seen.size > MAX) this.sweep(t);
      return fresh;
    }
    const hit = this.seen.get(key);
    if (!hit) return undefined;
    if (t - hit.at > TTL_MS) {
      this.seen.delete(key);
      return undefined;
    }
    return hit.name;
  }

  private sweep(t: number): void {
    for (const [k, v] of this.seen) if (t - v.at > TTL_MS) this.seen.delete(k);
    // Ainda cheio (muitos tokens vivos): descarta os mais antigos.
    if (this.seen.size > MAX) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.seen.size - MAX);
      for (const [k] of oldest) this.seen.delete(k);
    }
  }
}
