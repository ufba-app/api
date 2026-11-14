import type { ClientView } from '../oauth/client-directory';

/** O app web é o cliente OAuth da casa (sem tela de consentimento). */
export const WEB_CLIENT_ID = 'ufba-web';

/** Erro da API do web: `{ error, message }` com o status HTTP. `message` é pt-BR, pronta para mostrar. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const sessionExpired = () => new ApiError(401, 'session_expired', 'Sua sessão expirou. Entre de novo.');
export const requestNotFound = () => new ApiError(404, 'request_not_found', 'Pedido de autorização não encontrado.');

/** Quem chama a API do web: dono da sessão (cookie) com a K da sessão. */
export interface WebPrincipal {
  userId: string;
  clientId: string;
  chave?: Buffer;
}

export type SigaaStatus = 'connected' | 'disconnected' | 'password_required';
export type AccountStatus = 'connected' | 'reconnect_required';
export type GuestApp = 'ufba' | 'guest';

export interface Me {
  id: string;
  email: string | null;
  name: string | null;
  connections: {
    sigaa: { status: SigaaStatus; login: string | null };
    moodle: { status: AccountStatus | 'disconnected'; account: string | null };
    classroom: { available: boolean; apps: GuestApp[]; accounts: { email: string; status: AccountStatus }[] };
  };
}

export interface RequestInfo {
  id: string;
  client: ClientView;
  signedIn: boolean;
  sources: { source: 'sigaa' | 'moodle' | 'classroom'; status: SigaaStatus | AccountStatus | 'disconnected' }[] | null;
  expiresAt: string;
}

export interface AuthorizedApp extends Omit<ClientView, 'redirectUri' | 'metadata'> {
  clientId: string;
  authorizedAt: string;
  lastUsedAt: string | null;
  sigaa: boolean;
}
