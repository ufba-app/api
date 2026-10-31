import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'plt_';

export interface GeneratedApiKey {
  /** Valor completo: mostrado UMA vez, nunca guardado. */
  plain: string;
  hash: string;
  /** Primeiros caracteres, só para a pessoa reconhecer a chave numa lista. */
  prefix: string;
}

export function hashApiKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const plain = PREFIX + randomBytes(32).toString('base64url');
  return { plain, hash: hashApiKey(plain), prefix: plain.slice(0, 8) };
}
