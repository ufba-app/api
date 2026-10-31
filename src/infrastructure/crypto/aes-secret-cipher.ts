import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '../../application/ports/repositories';
import { SecretCipher } from '../../application/ports/secret-cipher';

/** AES-256-GCM. A chave vem de `SECRETS_KEY` (32 bytes em base64 ou 64 hex). */
@Injectable()
export class AesSecretCipher extends SecretCipher {
  private readonly key: Buffer;

  constructor(rawKey: string | undefined = process.env.SECRETS_KEY) {
    super();
    this.key = parseKey(rawKey);
  }

  encrypt(plain: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(secret.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function parseKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'SECRETS_KEY ausente: defina 32 bytes em base64 (ou 64 caracteres hex).',
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRETS_KEY deve ter exatamente 32 bytes.');
  }
  return key;
}
