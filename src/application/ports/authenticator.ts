/**
 * Resolve um Bearer token para um usuário. Há um autenticador por tipo de credencial (chave de API estática hoje;
 * token OAuth do serviço quando o Ponte entregar). O guard tenta todos, em ordem.
 */
export interface Authenticator {
  authenticate(token: string): Promise<{ userId: string } | null>;
}

export const AUTHENTICATORS = Symbol('AUTHENTICATORS');
