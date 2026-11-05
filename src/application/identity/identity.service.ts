import { Injectable } from '@nestjs/common';
import type { Authenticator } from '../ports/authenticator';
import {
  ApiKeyRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  UserRepository,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import type { Provider } from '../ports/source-gateway';
import { generateApiKey, hashApiKey } from './api-key';

export class InvalidAccountError extends Error {}

/**
 * Identidade: usuários, chaves de API e contas de fonte.
 * `criarUsuario` e `conectarConta` também são a porta usada pelo OAuth do serviço (Ponte).
 */
@Injectable()
export class IdentityService implements Authenticator {
  constructor(
    private readonly users: UserRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
  ) {}

  /** Cria o usuário. Sem `emitirChave: false`, também emite a primeira chave de API. */
  async criarUsuario(input: {
    name?: string;
    emitirChave?: boolean;
  }): Promise<{ userId: string; apiKey?: string }> {
    const user = await this.users.create({ name: input.name });
    if (input.emitirChave === false) return { userId: user.id };
    return { userId: user.id, apiKey: await this.emitirChave(user.id) };
  }

  /** Devolve o valor completo da chave: é a única vez que ele existe. */
  async emitirChave(userId: string, label?: string): Promise<string> {
    const key = generateApiKey();
    await this.apiKeys.create({
      userId,
      keyHash: key.hash,
      prefix: key.prefix,
      label,
    });
    return key.plain;
  }

  async authenticate(token: string): Promise<{ userId: string } | null> {
    const found = await this.apiKeys.findActiveByHash(hashApiKey(token));
    if (!found) return null;
    await this.apiKeys.touch(found.id, new Date());
    return { userId: found.userId };
  }

  /**
   * Cria/atualiza uma conta de fonte. `secretPlain` (token do Moodle, refresh token do Google) é cifrado antes de
   * gravar. SIGAA NUNCA aceita segredo (docs/ARQUITETURA.md §2.3).
   */
  async conectarConta(input: {
    userId: string;
    provider: Provider;
    accountKey: string;
    siteUrl?: string;
    secretPlain?: string;
  }): Promise<SourceAccountRecord> {
    if (input.provider === 'SIGAA' && input.secretPlain !== undefined) {
      throw new InvalidAccountError(
        'A conta do SIGAA nunca guarda segredo: a senha só viaja na consulta, em memória.',
      );
    }
    return this.accounts.upsert({
      userId: input.userId,
      provider: input.provider,
      accountKey: input.accountKey,
      siteUrl: input.siteUrl,
      secret:
        input.secretPlain !== undefined
          ? this.cipher.encrypt(input.secretPlain)
          : undefined,
    });
  }
}
