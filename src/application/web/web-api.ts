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
}
