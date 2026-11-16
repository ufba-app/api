import { randomBytes } from 'node:crypto';
import type { Provider } from '../ports/source-gateway';

/** Teto de usos de um link (o padrão é 1). */
export const MAX_USOS = 5;

export interface DownloadTicket {
  userId: string;
  provider: Provider;
  /** Conta da fonte de onde o anexo veio (resolvida quando o link é criado). */
  conta: string;
  ref: string;
  nome?: string;
  expiresAt: number;
  /** Quantas vezes o link ainda vale (1 = uso único). */
  usosRestantes: number;
  /** Entrega `inline` (para quem lê o link, como o chat web) em vez de `attachment`. */
  inline?: boolean;
}

/**
 * Links de download temporários: o MCP devolve um link; quem baixa (o cliente, na máquina da pessoa) usa uma vez.
 * O arquivo é buscado na fonte NA HORA do download e repassado, sem guardar. Só em memória: um link morre ao
 * reiniciar o servidor e não vale entre instâncias (aceitável: valem minutos). Uso único por padrão; o chat web (que lê o
 * link com a ferramenta de leitura de URL, sujeita a repetir a requisição) pede alguns usos, sempre poucos e por pouco tempo.
 */
export class DownloadLinks {
  private readonly tickets = new Map<string, DownloadTicket>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  criar(t: Omit<DownloadTicket, 'expiresAt' | 'usosRestantes'> & { usos?: number }): { id: string; expiresAt: Date } {
    this.limpar();
    const { usos, ...rest } = t;
    const id = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, { ...rest, expiresAt, usosRestantes: Math.min(Math.max(Math.trunc(usos ?? 1), 1), MAX_USOS) });
    return { id, expiresAt: new Date(expiresAt) };
  }

  /** Gasta um uso e devolve o ticket; no último uso (ou expirado) ele some. `undefined` se não existe ou expirou. */
  consumir(id: string): DownloadTicket | undefined {
    const t = this.tickets.get(id);
    if (!t || t.expiresAt <= this.now()) {
      this.tickets.delete(id);
      return undefined;
    }
    t.usosRestantes -= 1;
    if (t.usosRestantes <= 0) this.tickets.delete(id);
    return { ...t };
  }

  /** Olha o ticket SEM gastar uso (para `HEAD`). */
  espiar(id: string): DownloadTicket | undefined {
    const t = this.tickets.get(id);
    return t && t.expiresAt > this.now() ? { ...t } : undefined;
  }

  private limpar(): void {
    const agora = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= agora) this.tickets.delete(id);
  }
}
