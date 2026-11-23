import { randomBytes } from 'node:crypto';
import type { RequisitosEntrega } from '../ports/live-source';

export interface UploadTicket {
  userId: string;
  conta: string;
  cursoId: string;
  tarefaId: string;
  requisitos: RequisitosEntrega;
  expiresAt: number;
}

export interface RascunhoGuardado {
  userId: string;
  conta: string;
  tarefaId: string;
  itemId: string;
  arquivos: { nome: string; tamanhoBytes: number }[];
  expiresAt: number;
}

const novoId = (): string => randomBytes(24).toString('base64url');

/**
 * Links de upload temporários (uso único): o MCP devolve um link; a pessoa envia os arquivos por ele. Depois do envio,
 * o resultado (rascunho guardado no AVA) fica disponível para o dono pelo mesmo id, com o mesmo prazo a partir do envio.
 * Só em memória; o id age como credencial, nunca é logado nem persistido.
 */
export class UploadLinks {
  private readonly tickets = new Map<string, UploadTicket>();
  private readonly rascunhos = new Map<string, RascunhoGuardado>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  abrir(t: Omit<UploadTicket, 'expiresAt'>): { id: string; expiresAt: Date } {
    this.limpar();
    const id = novoId();
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, { ...t, expiresAt });
    return { id, expiresAt: new Date(expiresAt) };
  }

  /** Uso único: devolve o ticket e o apaga. `undefined` se não existe ou expirou. */
  consumir(id: string): UploadTicket | undefined {
    const t = this.tickets.get(id);
    this.tickets.delete(id);
    if (!t || t.expiresAt <= this.now()) return undefined;
    return { ...t };
  }

  /** Confere o ticket SEM gastar o uso (para recusar cedo, antes de ler o corpo). `undefined` se não existe ou expirou. */
  espiar(id: string): UploadTicket | undefined {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    if (t.expiresAt <= this.now()) {
      this.tickets.delete(id);
      return undefined;
    }
    return { ...t };
  }

  guardar(id: string, r: Omit<RascunhoGuardado, 'expiresAt'>): void {
    this.limpar();
    this.rascunhos.set(id, { ...r, expiresAt: this.now() + this.ttlMs });
  }

  /** Só o dono lê; não gasta nada. */
  ler(id: string, userId: string): RascunhoGuardado | undefined {
    const r = this.rascunhos.get(id);
    if (!r) return undefined;
    if (r.expiresAt <= this.now()) {
      this.rascunhos.delete(id);
      return undefined;
    }
    return r.userId === userId ? { ...r, arquivos: r.arquivos.map((a) => ({ ...a })) } : undefined;
  }

  private limpar(): void {
    const agora = this.now();
    for (const [id, t] of this.tickets) if (t.expiresAt <= agora) this.tickets.delete(id);
    for (const [id, r] of this.rascunhos) if (r.expiresAt <= agora) this.rascunhos.delete(id);
  }
}

export interface ConfirmacaoEntrega {
  userId: string;
  acao: 'rascunho' | 'enviar';
  conta: string;
  cursoId: string;
  tarefaId: string;
  itemId?: string;
  texto?: string;
  expiresAt: number;
}

/** Confirmações de curta duração (uso único) para gravar rascunho ou enviar para avaliação. Só em memória. */
export class ConfirmacoesEntrega {
  private readonly itens = new Map<string, ConfirmacaoEntrega>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  criar(c: Omit<ConfirmacaoEntrega, 'expiresAt'>): { id: string; expiresAt: Date } {
    this.limpar();
    const id = novoId();
    const expiresAt = this.now() + this.ttlMs;
    this.itens.set(id, { ...c, expiresAt });
    return { id, expiresAt: new Date(expiresAt) };
  }

  /** Só consome se for o dono e a ação combinar; caso contrário a confirmação continua valendo. */
  consumir(id: string, userId: string, acao: 'rascunho' | 'enviar'): ConfirmacaoEntrega | undefined {
    const c = this.itens.get(id);
    if (!c) return undefined;
    if (c.expiresAt <= this.now()) {
      this.itens.delete(id);
      return undefined;
    }
    if (c.userId !== userId || c.acao !== acao) return undefined;
    this.itens.delete(id);
    return { ...c };
  }

  private limpar(): void {
    const agora = this.now();
    for (const [id, c] of this.itens) if (c.expiresAt <= agora) this.itens.delete(id);
  }
}
