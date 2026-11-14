import { Injectable } from '@nestjs/common';
import { SecretCipher } from '../ports/secret-cipher';
import { Secret } from '../shared/secret';
import { MemoryAdmin, MemoryAdminError, MemoryUserRecord, MemoryUserRepository } from './memory-ports';

export const PROXY_LABEL = 'ufba-proxy';

/** `u` + 12 hex da parte aleatória do uuid v7 (os primeiros hex são o relógio): estável e sem PII. */
export function memoryUsernameOf(userId: string): string {
  return `u${userId.replace(/-/g, '').slice(-12).toLowerCase()}`;
}

export interface EnsuredMemoryUser {
  username: string;
}

/**
 * Cada pessoa = um usuário no ai-memory, criado na primeira vez e retomável se cair no meio. Duas credenciais
 * distintas por pessoa: a de repasse (`ufba-proxy`, guardada cifrada aqui) e as de computador (E3, nunca guardadas).
 */
@Injectable()
export class MemoryUsers {
  private readonly inflight = new Map<string, Promise<EnsuredMemoryUser>>();

  constructor(
    private readonly admin: MemoryAdmin,
    private readonly repo: MemoryUserRepository,
    private readonly cipher: SecretCipher,
    /** Nome de exibição (Google) de quem será criado; só é consultado na criação. */
    private readonly nameOf: (userId: string) => Promise<string | null> = async () => null,
  ) {}

  /** Garante usuário e chave de repasse. Idempotente; chamadas simultâneas da mesma pessoa viram uma só. */
  ensure(userId: string, displayName?: string | null): Promise<EnsuredMemoryUser> {
    const running = this.inflight.get(userId);
    if (running) return running;
    const p = this.doEnsure(userId, displayName ?? null).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, p);
    return p;
  }

  /** A chave de repasse aberta, só para o proxy do MCP e para chamadas em nome da pessoa. */
  async proxyKey(userId: string): Promise<Secret> {
    const row = await this.repo.find(userId);
    if (!row?.proxyKey || row.status !== 'ready') {
      throw new MemoryAdminError('not_found');
    }
    return Secret.of(this.cipher.decrypt(row.proxyKey));
  }

  private async doEnsure(userId: string, displayName: string | null): Promise<EnsuredMemoryUser> {
    if (!this.admin.isConfigured()) throw new MemoryAdminError('unavailable');
    let row = await this.repo.find(userId);
    if (row?.status === 'ready') return { username: row.memoryUsername };
    if (row?.status === 'disabled') throw new MemoryAdminError('forbidden');
    displayName ??= await this.nameOf(userId);
    row ??= await this.repo.createIfAbsent({ userId, memoryUsername: memoryUsernameOf(userId) });
    if (row.status === 'ready') return { username: row.memoryUsername };

    const username = row.memoryUsername;
    // 409 (já existe) não é erro: a criação no memory é idempotente por username.
    await this.admin.createHumanUser({ username, name: displayName ?? undefined });
    if (!row.proxyKey) await this.issueProxy(row, displayName);
    await this.repo.markReady(userId);
    return { username };
  }

  private async issueProxy(row: MemoryUserRecord, displayName: string | null): Promise<void> {
    // Retomada: se uma execução anterior criou a credencial mas caiu antes de gravar, o segredo se perdeu; revoga a órfã.
    for (const c of await this.admin.listCredentials(row.memoryUsername)) {
      if (c.label === PROXY_LABEL && !c.revokedAt && c.id !== row.proxyCredentialId) {
        await this.admin.revokeCredential(c.id);
      }
    }
    const issued = await this.admin.issueCredential(row.memoryUsername, PROXY_LABEL);
    const saved = await this.repo.saveProxyIfAbsent(row.userId, {
      credentialId: issued.credential.id,
      key: this.cipher.encrypt(issued.token.reveal()),
      displayName,
    });
    if (!saved) await this.admin.revokeCredential(issued.credential.id);
  }
}
