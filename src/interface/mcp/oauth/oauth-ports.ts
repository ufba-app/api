/**
 * Portas do servidor OAuth 2.1 do serviço (clientes MCP como Claude).
 * O Núcleo (Forja) fornece usuários e SourceAccount; as fontes fornecem os vínculos.
 * Enquanto isso, há implementações em memória/stub (ver `memory-oauth-store.ts`).
 */

export const OAUTH_STORE = Symbol('OAUTH_STORE');
export const USER_DIRECTORY = Symbol('USER_DIRECTORY');
export const GOOGLE_LINK = Symbol('GOOGLE_LINK');
export const MOODLE_LINK = Symbol('MOODLE_LINK');

export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

/** Pedido de autorização em andamento (guardado entre as telas). */
export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope?: string;
  /** Preenchido depois que o usuário se identifica. */
  userId?: string;
  expiresAt: number;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  codeChallenge: string;
  scope?: string;
  expiresAt: number;
}

export interface TokenRecord {
  /** Hash SHA-256 do token (o token em claro nunca é guardado). */
  tokenHash: string;
  kind: 'access' | 'refresh';
  clientId: string;
  userId: string;
  scope?: string;
  expiresAt: number;
}

export interface OAuthStore {
  saveClient(c: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  savePending(p: PendingAuthorization): Promise<void>;
  getPending(id: string): Promise<PendingAuthorization | null>;
  deletePending(id: string): Promise<void>;
  saveCode(c: AuthCode): Promise<void>;
  /** Consome o código (uso único): devolve e apaga. */
  takeCode(code: string): Promise<AuthCode | null>;
  saveToken(t: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | null>;
  /** Rotação do refresh token: apaga o token usado. */
  deleteToken(tokenHash: string): Promise<void>;
}

/** Identifica ou cria o usuário (a ser ligado ao UserRepository do Núcleo). */
export interface UserDirectory {
  findOrCreateByEmail(email: string): Promise<{ id: string }>;
}

export interface LinkStatus {
  connected: boolean;
}

/** Vínculo com o Google (OAuth, Classroom + Calendar). Quem implementa é o módulo Google. */
export interface GoogleLinkPort {
  status(userId: string): Promise<LinkStatus>;
  /** URL do consentimento do Google; `callbackUrl` é o callback https do serviço. */
  startUrl(userId: string, callbackUrl: string, state: string): Promise<string>;
  /** Troca o code pelos tokens e guarda cifrado. */
  handleCallback(userId: string, code: string, callbackUrl: string): Promise<void>;
}

/**
 * Vínculo com o Moodle por SSO (launch.php do Moodle Mobile). Não existe campo para colar token.
 * Quem implementa é o módulo Moodle (funções puras de token da Maresia); o spike do redirect está aberto.
 */
export interface MoodleLinkPort {
  status(userId: string): Promise<LinkStatus>;
  /** URL do launch.php (com passport/urlscheme) para onde mandar o usuário. */
  startUrl(userId: string, returnUrl: string): Promise<string>;
  /** Recebe o retorno do launch.php (token em base64), valida e guarda cifrado. */
  handleReturn(userId: string, payload: string): Promise<void>;
}
