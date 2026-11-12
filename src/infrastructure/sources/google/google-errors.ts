import type { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { GoogleApiError } from './google-http';

/** Extrai o refresh token (decifrado) do contexto; Google só usa credencial `token`. */
export function refreshTokenOf(ctx: SourceContext): Secret {
  if (ctx.credentials.kind !== 'token') {
    throw new SourceError('CREDENTIAL_REJECTED', 'Fonte Google exige credencial do tipo token');
  }
  return ctx.credentials.token;
}

/** Converte erro HTTP do Google em SourceError com código estável. */
export async function translateErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GoogleApiError) {
      if (e.status === 400 || e.status === 401) throw new SourceError('REAUTH_NEEDED', e.message);
      if (e.status === 403) throw new SourceError('CREDENTIAL_REJECTED', e.message);
      throw new SourceError('UNAVAILABLE', e.message);
    }
    throw e;
  }
}
