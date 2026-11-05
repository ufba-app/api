import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '../../application/ports/repositories';
import { SecretCipher } from '../../application/ports/secret-cipher';
import { parseSecretsKey } from './keys';

/**
 * Única cifra de segredos guardados (tokens do Moodle e do Google): AES-256-GCM, IV aleatório por cifragem.
 * A chave é a `SECRETS_KEY` (32 bytes em base64 ou 64 hex). Nunca loga o texto claro.
 */
@Injectable()
export class AesSecretCipher extends SecretCipher {
  private readonly key: Buffer;

  constructor(rawKey: string | undefined = process.env.SECRETS_KEY) {
    super();
    this.key = parseSecretsKey(rawKey);
  }

  encrypt(plain: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
