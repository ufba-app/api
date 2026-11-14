import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** PKCE S256 (RFC 7636): base64url(sha256(verifier)) deve ser igual ao challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(sha256Base64Url(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
