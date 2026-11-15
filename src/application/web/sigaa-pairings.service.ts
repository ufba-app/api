import { RateWindow } from '../memory/rate-window';
import { randomToken } from '../oauth/pkce';
import { SigaaPairingRepository, type SigaaPairingPacket } from '../ports/repositories';
import type { SeenClient } from './user-agent';
import { ApiError, type WebPrincipal } from './web-api';

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_OPEN_PAIRINGS = 3;

export interface PairingInfo {
  /** O que o computador DIZ de si: não é confiável, a tela mostra como "o computador diz". */
  label: string | null;
  client: string | null;
  /** O que a API VIU (User-Agent) ao receber o pedido: é o que o celular mostra antes de pedir a digital. */
  seenBrowser: string | null;
  seenOs: string | null;
  createdAt: Date;
  expiresAt: Date;
  delivered: boolean;
}

export type PairingRead = { status: 'pending' } | ({ status: 'delivered' } & SigaaPairingPacket);

/**
 * "Correio" do QR (docs/specs/2026-11-14-chave-mestra-passkey.md §13). O computador cria o pedido, preso à conta dele;
 * o celular entrega um pacote lacrado para a chave descartável do computador; o computador lê uma vez só. O pacote é
 * opaco (o servidor não tem a chave para abri-lo) e o pedido vale 5 minutos. Os dois lados precisam estar logados na
 * MESMA conta: um pedido de outra conta responde como "não encontrado" (não revela que existe).
 *
 * Premissa: a API roda em UMA instância (os limites abaixo vivem em memória, como o RateWindow do resto da casa).
 */
export class SigaaPairings {
  private readonly creates: RateWindow;
  private readonly reads: RateWindow;
  private readonly delivers: RateWindow;
  private readonly infos: RateWindow;

  constructor(
    private readonly repo: SigaaPairingRepository,
    private readonly now: () => number = Date.now,
  ) {
    this.creates = new RateWindow(10, 60 * 60_000, this.now);
    // O computador consulta a cada ~1,5 s durante 5 min (~200 leituras).
    this.reads = new RateWindow(300, PAIRING_TTL_MS, this.now);
    this.delivers = new RateWindow(10, 60_000, this.now);
    this.infos = new RateWindow(30, 60_000, this.now);
  }

  async create(
    p: WebPrincipal,
    input: { label?: string; client?: string },
    seen: SeenClient = { browser: null, os: null },
  ): Promise<{ id: string; expiresAt: Date }> {
    const at = new Date(this.now());
    await this.repo.deleteExpired(at);
    if ((await this.repo.countOpen(p.userId, at)) >= MAX_OPEN_PAIRINGS || !this.creates.take(p.userId)) {
      throw new ApiError(429, 'too_many_attempts', 'Muitos pedidos de liberação abertos. Aguarde alguns minutos e tente de novo.');
    }
    const id = randomToken(16);
    const expiresAt = new Date(at.getTime() + PAIRING_TTL_MS);
    await this.repo.create({
      id,
      userId: p.userId,
      label: input.label ?? null,
      client: input.client ?? null,
      seenBrowser: seen.browser,
      seenOs: seen.os,
      createdAt: at,
      expiresAt,
    });
    return { id, expiresAt };
  }

  /** O que o celular mostra antes de pedir a digital: quem está pedindo. */
  async info(p: WebPrincipal, id: string): Promise<PairingInfo> {
    if (!this.infos.take(p.userId)) throw tooMany();
    const r = await this.repo.find(id, p.userId, new Date(this.now()));
    if (!r) throw notFound();
    return { label: r.label, client: r.client, seenBrowser: r.seenBrowser, seenOs: r.seenOs, createdAt: r.createdAt, expiresAt: r.expiresAt, delivered: r.packet !== null };
  }

  /** O celular entrega o pacote lacrado. Uma vez só por pedido. */
  async deliver(p: WebPrincipal, id: string, packet: SigaaPairingPacket): Promise<void> {
    if (!this.delivers.take(p.userId)) throw tooMany();
    const at = new Date(this.now());
    if (await this.repo.deliver(id, p.userId, packet, at)) return;
    // Não entregou: ou o pedido não existe/venceu/é de outra conta, ou já havia pacote.
    if (!(await this.repo.find(id, p.userId, at))) throw notFound();
    throw new ApiError(409, 'pairing_already_delivered', 'Este pedido já foi respondido. Gere um QR novo no computador.');
  }

  /** O computador pergunta. Com pacote: devolve e APAGA (uso único). */
  async read(p: WebPrincipal, id: string): Promise<PairingRead> {
    if (!this.reads.take(p.userId)) throw tooMany();
    const at = new Date(this.now());
    const packet = await this.repo.take(id, p.userId, at);
    if (packet) return { status: 'delivered', ...packet };
    if (!(await this.repo.find(id, p.userId, at))) throw notFound();
    return { status: 'pending' };
  }
}

const tooMany = () => new ApiError(429, 'too_many_attempts', 'Muitas tentativas. Aguarde um pouco e tente de novo.');
const notFound = () =>
  new ApiError(404, 'pairing_not_found', 'Pedido de liberação não encontrado, vencido ou de outra conta. Gere um QR novo no computador.');
