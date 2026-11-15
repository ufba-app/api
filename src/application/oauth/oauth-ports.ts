import type { Secret } from '../shared/secret';
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
export const SIGAA_LINK = Symbol('SIGAA_LINK');

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

export interface ClientLogo {
  /** sha256 hex dos bytes: vira o caminho público `/client-logos/<hash>`. */
  hash: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Buffer;
}

export interface OAuthClient {
  clientId: string;
  /** Do /register: declarado pelo próprio cliente, NUNCA mostrado. Do documento de metadados: saneado. */
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
  /** true quando o client_id é uma URL https (documento de metadados do cliente). */
  fromMetadata?: boolean;
  /** Na leitura: só o hash do logo guardado (os bytes vêm por `getClientLogo`). */
  logoHash?: string;
  /** Na escrita (`upsertClient`): logo novo; `null` apaga o anterior. */
  logo?: ClientLogo | null;
}

/**
 * Erro ao conectar uma fonte, com um código estável para a API do web. A mensagem é pt-BR, pronta para mostrar, e
 * nunca contém senha nem token.
 */
export type LinkErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'source_unavailable'
  // Vínculo fixo (domain/identity/source-binding): titular de outra conta, conta já ligada a outro titular, conta da
  // fonte que não é desta pessoa.
  | 'source_account_taken'
  | 'source_account_mismatch'
  | 'source_account_not_owned'
  // SIASB: senha recusada, senha ainda no formato antigo (entrar uma vez no SIASB) e SIASB fora do ar.
  | 'siasb_credentials_rejected'
  | 'siasb_password_migration_required'
  | 'siasb_unavailable';
export class LinkError extends Error {
  constructor(
    message: string,
    readonly code: LinkErrorCode = 'invalid_credentials',
  ) {
    super(message);
  }
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
  /** `session`: sessão do app web (cookie HttpOnly), validade renovada a cada uso. */
  kind: 'access' | 'refresh' | 'session';
  clientId: string;
  userId: string;
  scope?: string;
  expiresAt: number;
  createdAt?: number;
  lastUsedAt?: number;
}

export interface OAuthStore {
  saveClient(c: OAuthClient): Promise<void>;
  /** Cria ou atualiza (cliente fixo do web, clientes de documento de metadados). */
  upsertClient(c: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  getClientLogo(hash: string): Promise<Omit<ClientLogo, 'hash'> | null>;
  savePending(p: PendingAuthorization): Promise<void>;
  /** Devolve também pedidos já expirados (quem chama decide entre 410 e 404). */
  getPending(id: string): Promise<PendingAuthorization | null>;
  /**
   * Atômico: liga o pedido (não expirado) a `userId` se ainda não tem dono, ou confirma se já é dele. false = pedido
   * de outra pessoa, expirado ou inexistente.
   */
  claimPending(id: string, userId: string, now: number): Promise<boolean>;
  /** Atômico: apaga e devolve o pedido (uso único: de duas chamadas simultâneas, só uma recebe). */
  takePending(id: string): Promise<PendingAuthorization | null>;
  deletePending(id: string): Promise<void>;
  saveCode(c: AuthCode): Promise<void>;
  /** Consome o código (uso único): devolve e apaga. */
  takeCode(code: string): Promise<AuthCode | null>;
  saveToken(t: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | null>;
  /** Rotação do refresh token: apaga o token usado. */
  deleteToken(tokenHash: string): Promise<void>;
  /** Tokens válidos (não expirados) da pessoa. */
  listTokens(userId: string): Promise<TokenRecord[]>;
  /** Revoga um cliente para a pessoa: apaga todos os tokens dele. */
  deleteTokensOfClient(userId: string, clientId: string): Promise<void>;
  /** Marca uso (e, para sessão, estende a validade). */
  touchToken(tokenHash: string, lastUsedAt: number, expiresAt?: number): Promise<void>;
}

/** Identifica ou cria o usuário (a ser ligado ao UserRepository do Núcleo). */
export interface UserDirectory {
  findOrCreateByEmail(email: string): Promise<{ id: string }>;
  /** Sem criar: quem ainda não tem conta volta null (convite pendente). */
  findByEmail(email: string): Promise<{ id: string } | null>;
  /** Para o /me. */
  findProfile(userId: string): Promise<{ id: string; email: string | null; name: string | null } | null>;
  /** Exclui a pessoa e tudo dela (cascata no banco), inclusive pedidos de autorização em andamento. */
  deleteAccount(userId: string): Promise<void>;
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
  startUrl(app: AppClassroom, callbackUrl: string, state: string): Promise<string>;
  /** Troca o code, confere o domínio, faz 1 leitura de teste e guarda o refresh token cifrado. */
  handleCallback(app: AppClassroom, userId: string, code: string, callbackUrl: string): Promise<{ email: string }>;
}

/**
 * Vínculo com o Moodle pelo launch.php do Moodle Mobile: a pessoa faz o login no PRÓPRIO navegador e o app web captura
 * o link de redirecionamento (`web+ufba://token=...`). Quem implementa é o módulo Moodle.
 */
/** O que o Moodle confirmou sobre o token capturado. */
export interface VerifiedMoodleAccount {
  siteUrl: string;
  host: string;
  /** Id numérico do usuário no AVA (não editável). */
  moodleUserId: number;
  username: string;
  /** Método de login da conta no AVA (`shibboleth` = login institucional). */
  auth: string;
  token: Secret;
}

export interface MoodleLinkPort {
  /** Esquema do redirect final do launch.php (ex.: `web+ufba`), que a tela registra como tratador. */
  scheme(): string;
  /** URL do launch.php (com passport/urlscheme) que a pessoa abre no próprio navegador. */
  launchUrl(userId: string, txn: string): Promise<string>;
  /**
   * Recebe o link capturado (`web+ufba://token=...`), confere a assinatura do passport e pergunta ao Moodle de quem é o
   * token. Não guarda nada: quem chama decide (é da pessoa? vínculo?) e grava.
   */
  verify(userId: string, txn: string, pasted: string): Promise<VerifiedMoodleAccount>;
}

/** SIGAA pelo app web: valida login e senha (quem chama decide onde guardar). */
export interface SigaaLinkPort {
  /**
   * 1 login real + GET do portal e devolve o login normalizado. Erro com mensagem amigável se a senha estiver errada;
   * senhas erradas demais (por chave, por usuário e por login) são recusadas sem falar com o SIGAA. Lança `LinkError`.
   */
  validar(chave: string, login: string, senha: Secret, userId: string): Promise<string>;
}
