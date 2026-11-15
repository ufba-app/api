import { RateWindow } from '../memory/rate-window';
import { SigaaMasterSlotRepository } from '../ports/repositories';
import type { ConnectionStatus } from './connection-status';
import { ApiError, type WebPrincipal } from './web-api';

export const MAX_PASSKEY_SLOTS = 5;

export interface PasskeyView {
  credentialId: string;
  prfSalt: string;
  label: string | null;
  createdAt: Date;
  lastUnlockedAt: Date | null;
}

export interface SaveSlotInput {
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
  label?: string;
}

/**
 * Chave mestra do SIGAA com passkey (docs/specs/2026-11-14-chave-mestra-passkey.md). A cópia da senha é cifrada NO
 * NAVEGADOR com o PRF da passkey; aqui só se guarda e se devolve o texto cifrado. A passkey não autentica ninguém (quem
 * autentica é a sessão): é só a chave da cópia. Por isso não há verificação de assertion no servidor.
 */
export class SigaaPasskeys {
  private readonly saves: RateWindow;
  private readonly unlocks: RateWindow;

  constructor(
    private readonly slots: SigaaMasterSlotRepository,
    private readonly status: ConnectionStatus,
    private readonly now: () => number = Date.now,
  ) {
    this.saves = new RateWindow(5, 60 * 60_000, this.now);
    this.unlocks = new RateWindow(10, 60_000, this.now);
  }

  async list(p: WebPrincipal): Promise<PasskeyView[]> {
    return (await this.slots.list(p.userId)).map((s) => ({
      credentialId: s.credentialId,
      prfSalt: s.prfSalt,
      label: s.label,
      createdAt: s.createdAt,
      lastUnlockedAt: s.lastUnlockedAt,
    }));
  }

  /** Só com o SIGAA conectado NESTA sessão: a cópia mestra é a senha que a pessoa acabou de provar que é dela. */
  async save(p: WebPrincipal, input: SaveSlotInput): Promise<void> {
    if (!(await this.status.sigaaOpens(p))) {
      throw new ApiError(409, 'source_not_connected', 'Conecte o SIGAA nesta sessão antes de guardar a senha com a passkey.');
    }
    const exists = await this.slots.find(p.userId, input.credentialId);
    if (!exists && (await this.slots.count(p.userId)) >= MAX_PASSKEY_SLOTS) {
      throw new ApiError(409, 'passkey_limit_reached', `Você já guardou a senha em ${MAX_PASSKEY_SLOTS} passkeys. Remova uma para adicionar outra.`);
    }
    if (!this.saves.take(p.userId)) throw tooMany();
    await this.slots.upsert(p.userId, {
      credentialId: input.credentialId,
      prfSalt: input.prfSalt,
      iv: input.iv,
      ciphertext: input.ciphertext,
      label: input.label ?? null,
    });
  }

  /** Devolve a cópia para o navegador abrir com a passkey. Marca o uso (a pessoa está desbloqueando agora). */
  async slot(p: WebPrincipal, credentialId: string): Promise<{ prfSalt: string; iv: string; ciphertext: string }> {
    if (!this.unlocks.take(p.userId)) throw tooMany();
    const s = await this.slots.find(p.userId, credentialId);
    if (!s) throw notFound();
    await this.slots.touch(p.userId, credentialId, new Date(this.now()));
    return { prfSalt: s.prfSalt, iv: s.iv, ciphertext: s.ciphertext };
  }

  async remove(p: WebPrincipal, credentialId: string): Promise<void> {
    if (!(await this.slots.delete(p.userId, credentialId))) throw notFound();
  }
}

const tooMany = () => new ApiError(429, 'too_many_attempts', 'Muitas tentativas. Aguarde um pouco e tente de novo.');
const notFound = () => new ApiError(404, 'passkey_not_found', 'Passkey não encontrada. Ela pode já ter sido removida.');
