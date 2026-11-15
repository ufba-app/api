import { SiasbSession } from '../ports/siasb-source';

/**
 * Único lugar que serializa o jar de cookies do SIASB. `SiasbSession` esconde o jar em toString/toJSON/inspect,
 * então a leitura é explícita por `cookies`. O resultado só pode ser cifrado, nunca logado.
 */
export function encodeSession(session: SiasbSession): string {
  return JSON.stringify(session.cookies);
}

export function decodeSession(json: string, expiresAt: Date | null): SiasbSession {
  const parsed: unknown = JSON.parse(json);
  const cookies: Record<string, string> = {};
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') cookies[k] = v;
  }
  return new SiasbSession(cookies, expiresAt, false);
}
