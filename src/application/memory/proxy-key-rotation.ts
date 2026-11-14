import type { EncryptedSecret } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import { MemoryAdmin } from './memory-ports';
import { MemoryUserRepository } from './memory-ports';

/** Onde fica a chave de repasse cifrada e quando girou (só o necessário para a rotação). */
export abstract class ProxyKeyStore {
  /** Grava a chave nova (já cifrada) e a data da rotação. */
  abstract replace(userId: string, key: EncryptedSecret, at: Date): Promise<void>;
  /** Zera a chave e volta o usuário a `creating`: o próximo `ensure` emite uma nova (recuperação). */
  abstract reset(userId: string): Promise<void>;
  /** Pessoas prontas cuja chave de repasse é mais velha que `before` (rotação ou, sem rotação, criação). */
  abstract listStale(before: Date, limit: number): Promise<string[]>;
}

export const DEFAULT_MAX_AGE_DAYS = 90;
export const MAX_ROTATIONS_PER_RUN = 20;

/**
 * Rotação da chave de repasse de UMA pessoa, sem tocar no token root (`rotate` no memory + regravar cifrada). A
 * antiga deixa de valer na hora; se não der para gravar a nova, a credencial é revogada e o usuário volta a `creating`
 * (o próximo uso emite outra), então nunca sobra chave válida sem dono.
 */
export class ProxyKeyRotation {
  constructor(
    private readonly admin: MemoryAdmin,
    private readonly users: MemoryUserRepository,
    private readonly store: ProxyKeyStore,
    private readonly cipher: SecretCipher,
    private readonly now: () => number = Date.now,
  ) {}

  /** Devolve false se a pessoa não tem chave de repasse (nada a girar). */
  async rotate(userId: string): Promise<boolean> {
    const row = await this.users.find(userId);
    if (!row?.proxyCredentialId || row.status !== 'ready') return false;
    const rotated = await this.admin.rotateCredential(row.proxyCredentialId);
    try {
      await this.store.replace(userId, this.cipher.encrypt(rotated.token.reveal()), new Date(this.now()));
    } catch (e) {
      await this.admin.revokeCredential(row.proxyCredentialId).catch(() => undefined);
      await this.store.reset(userId).catch(() => undefined);
      throw e;
    }
    return true;
  }

  /** Gira as chaves mais velhas que `maxAgeDays` (no máximo 20 por varredura). Devolve quantas. */
  async rotateStale(maxAgeDays = DEFAULT_MAX_AGE_DAYS, limit = MAX_ROTATIONS_PER_RUN): Promise<number> {
    if (!this.admin.isConfigured()) return 0;
    const before = new Date(this.now() - maxAgeDays * 86_400_000);
    let n = 0;
    for (const id of await this.store.listStale(before, limit)) {
      try {
        if (await this.rotate(id)) n++;
      } catch {
        // memory fora do ar ou credencial perdida: a próxima varredura tenta de novo
      }
    }
    return n;
  }
}
