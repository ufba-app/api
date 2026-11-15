import type { ApiErrorCode } from './contract';

export type {
  AccountStatus,
  ApiErrorCode,
  AuthorizedApp,
  GuestApp,
  Me,
  RequestInfo,
  SigaaStatus,
} from './contract';

/** O app web é o cliente OAuth da casa (sem tela de consentimento). */
export const WEB_CLIENT_ID = 'ufba-web';

/** Erro da API do web: `{ error, message }` com o status HTTP. `message` é pt-BR, pronta para mostrar. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const sessionExpired = () => new ApiError(401, 'session_expired', 'Sua sessão expirou. Entre de novo.');
export const requestNotFound = () => new ApiError(404, 'request_not_found', 'Pedido de autorização não encontrado.');
export const invalidRequest = () => new ApiError(400, 'invalid_request', 'Pedido inválido. Confira os dados e tente de novo.');

/** Quem chama a API do web: dono da sessão (cookie) com a K da sessão. */
export interface WebPrincipal {
  userId: string;
  clientId: string;
  chave?: Buffer;
  /** Quando a sessão vence (ms). Só vem do cookie de sessão. */
  sessionExpiresAt?: number;
  /** Identifica ESTA sessão (derivada do hash do token; não revela o token). Só vem do cookie de sessão. */
  sessionKey?: string;
}

/** Prefixo do `clientId` das cópias da DK das sessões do painel: `ufba-web:<sessão>`. */
export const WEB_COPY_PREFIX = `${WEB_CLIENT_ID}:`;
/** Quantas sessões do painel por pessoa mantêm cópia da DK (as mais novas): evita cópias órfãs de sessões que venceram. */
export const MAX_WEB_COPIES = 20;

/**
 * Dono da cópia da DK desta sessão do painel. É POR SESSÃO: com uma cópia só para todas as sessões, desbloquear num aparelho
 * (celular ou QR) sobrescreveria a dos outros e "Sair" num aparelho trancaria os demais.
 */
export const webCopyOf = (p: WebPrincipal): { userId: string; clientId: string } => {
  if (!p.sessionKey) throw sessionExpired();
  return { userId: p.userId, clientId: `${WEB_COPY_PREFIX}${p.sessionKey}` };
};
