import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Cifra segredos (ex.: refresh token do Google) com AES-256-GCM antes de gravar no banco.
 * Formato: `v1:<iv>:<tag>:<cifrado>` (base64). Nunca loga o texto claro.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = SecretBox.parseKey(key);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
    const raw = env.SECRETS_KEY;
    if (!raw) throw new Error('SECRETS_KEY não definida');
    return new SecretBox(raw);
  }

  /** Aceita 32 bytes em hex (64 chars) ou base64. */
  private static parseKey(key: string | Buffer): Buffer {
    const buf = Buffer.isBuffer(key)
      ? key
      : /^[0-9a-fA-F]{64}$/.test(key)
        ? Buffer.from(key, 'hex')
        : Buffer.from(key, 'base64');
    if (buf.length !== 32) {
      throw new Error('SECRETS_KEY deve ter 32 bytes (hex de 64 chars ou base64)');
    }
    return buf;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error('Segredo cifrado em formato inválido');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}
