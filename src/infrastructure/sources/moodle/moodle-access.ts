import type { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';

/** O que as chamadas ao Moodle precisam: raiz do site e wstoken. */
export interface MoodleAccess {
  baseUrl: string;
  token: Secret;
}

/** Extrai baseUrl+wstoken do contexto da porta. Moodle exige conta com token guardado. */
export function accessOf(ctx: SourceContext): MoodleAccess {
  if (ctx.credentials.kind !== 'token' || !ctx.siteUrl) {
    throw new SourceError(
      'CREDENTIAL_REJECTED',
      'Moodle exige siteUrl e credencial do tipo token',
    );
  }
  return { baseUrl: ctx.siteUrl, token: ctx.credentials.token };
}
