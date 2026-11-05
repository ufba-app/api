import { randomBytes } from 'node:crypto';
import type { Provider } from '../ports/source-gateway';

export interface DownloadTicket {
  userId: string;
  provider: Provider;
  /** Conta da fonte de onde o anexo veio (resolvida quando o link é criado). */
  conta: string;
  ref: string;
  nome?: string;
  expiresAt: number;
}

/**
 * Links de download temporários: o MCP devolve um link; quem baixa (o cliente, na máquina da pessoa) usa uma vez.
 * O arquivo é buscado na fonte NA HORA do download e repassado, sem guardar. Só em memória: um link morre ao
 * reiniciar o servidor e não vale entre instâncias (aceitável: valem minutos).
 */
export class DownloadLinks {
  private readonly tickets = new Map<string, DownloadTicket>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  criar(t: Omit<DownloadTicket, 'expiresAt'>): { id: string; expiresAt: Date } {
    this.limpar();
    const id = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, { ...t, expiresAt });
    return { id, expiresAt: new Date(expiresAt) };
  }

  /** Uso único: devolve e apaga. `undefined` se não existe ou expirou. */
  consumir(id: string): DownloadTicket | undefined {
    const t = this.tickets.get(id);
    this.tickets.delete(id);
    if (!t || t.expiresAt <= this.now()) return undefined;
    return t;
  }

  private limpar(): void {
    const agora = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= agora) this.tickets.delete(id);
  }
}
