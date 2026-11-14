import { hkdfSync } from 'node:crypto';

/** `SECRETS_KEY`: 32 bytes em base64 ou 64 caracteres hex. */
export function parseSecretsKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error('SECRETS_KEY ausente: defina 32 bytes em base64 (ou 64 caracteres hex).');
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRETS_KEY deve ter exatamente 32 bytes.');
  }
  return key;
}

/**
 * Chave própria para uma finalidade, derivada da `SECRETS_KEY` por HKDF-SHA256. Cada uso (ex.: assinar o passport do
 * Moodle) tem a sua; a chave mestra em si só cifra os segredos guardados (`AesSecretCipher`).
 */
export function deriveKey(raw: string | undefined, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', parseSecretsKey(raw), Buffer.alloc(0), purpose, 32));
}
