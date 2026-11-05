/**
 * Portas do servidor OAuth 2.1 do serviço (clientes MCP como Claude).
 * O Núcleo (Forja) fornece usuários e SourceAccount; as fontes fornecem os vínculos.
 * Enquanto isso, há implementações em memória/stub (ver `memory-oauth-store.ts`).
 */

export const OAUTH_STORE = Symbol('OAUTH_STORE');
export const USER_DIRECTORY = Symbol('USER_DIRECTORY');
export const GOOGLE_LINK = Symbol('GOOGLE_LINK');
export const MOODLE_LINK = Symbol('MOODLE_LINK');
export const CHAVE_DO_CLIENTE = Symbol('CHAVE_DO_CLIENTE');

/**
 * Chave K do cliente (cifra a senha do SIGAA). Nasce no momento do /token e viaja só no sufixo do token do cliente;
 * o servidor nunca a guarda. Quem implementa é o cofre do SIGAA.
 */
export interface ChaveDoClientePort {
  /** Liga a transação (tela de autorização) ao hash do authorization code emitido. */
  vincularCodigo(txn: string, codeHash: string): void;
  /** Troca o code por K (gerada e usada para cifrar a senha); null se não há credencial pendente. */
  gravarNoToken(codeHash: string, quem: { userId: string; clientId: string }): Promise<Buffer | null>;
}

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

/** Login do serviço com Google (só identidade, domínio institucional). Quem implementa é o módulo Google. */
export interface GoogleLinkPort {
  /** true quando o Google está configurado: aí ele É o login do serviço (sem e-mail/senha digitados). */
  loginEnabled(): boolean;
  /** URL do consentimento de LOGIN (só openid/email/profile, restrito ao domínio permitido). */
  startLoginUrl(callbackUrl: string, state: string): Promise<string>;
  /** Troca o code e devolve o e-mail verificado do domínio permitido; lança se não for. */
  handleLoginCallback(code: string, callbackUrl: string): Promise<{ email: string }>;
}

export const CLASSROOM_LINK = Symbol('CLASSROOM_LINK');

/**
 * Qual app OAuth conecta o Classroom: `ufba` = o app interno do login (contas do domínio, sem limite);
 * `convidado` = o app externo em teste (gmail pessoal, só usuários de teste adicionados à mão).
 */
export type AppClassroom = 'ufba' | 'convidado';

/** Conectar o Classroom (pode ser mais de uma conta). */
export interface ClassroomLinkPort {
  enabled(): boolean;
  /** Apps configurados neste servidor. */
  apps(): AppClassroom[];
  /** E-mails das contas conectadas e válidas. */
  contas(userId: string): Promise<string[]>;
  startUrl(app: AppClassroom, callbackUrl: string, state: string): Promise<string>;
  /** Troca o code, confere o domínio, faz 1 leitura de teste e guarda o refresh token cifrado. */
  handleCallback(app: AppClassroom, userId: string, code: string, callbackUrl: string): Promise<{ email: string }>;
}

/**
 * Vínculo com o Moodle pelo launch.php do Moodle Mobile: a pessoa faz o login no PRÓPRIO navegador e cola na tela o
 * link de redirecionamento (`moodlemobile://token=...`). Quem implementa é o módulo Moodle.
 */
export interface MoodleLinkPort {
  status(userId: string): Promise<LinkStatus>;
  /** Host do Moodle (para a tela explicar onde fazer o login). */
  host(): string;
  /** Esquema do redirect final do launch.php (ex.: `web+ufba`), que a tela registra como tratador. */
  scheme(): string;
  /** URL do launch.php (com passport/urlscheme) que a pessoa abre no próprio navegador. */
  launchUrl(userId: string, txn: string): Promise<string>;
  /** Recebe o link colado (`moodlemobile://token=...`), confere a assinatura, valida o token e guarda cifrado. */
  connect(userId: string, txn: string, pasted: string): Promise<void>;
}
