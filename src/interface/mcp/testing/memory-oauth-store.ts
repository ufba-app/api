import {
  AuthCode,
  ClassroomLinkPort,
  ClientLogo,
  GoogleLinkPort,
  LinkError,
  LinkStatus,
  MoodleLinkPort,
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
  SigaaLinkPort,
  TokenRecord,
  UserDirectory,
} from '../../../application/oauth/oauth-ports';

/** Store em memória (testes). Pedidos expirados voltam como estão: quem chama decide (ver OAuthStore). */
export class MemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private logos = new Map<string, ClientLogo>();
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, TokenRecord>();

  async saveClient(c: OAuthClient) {
    this.clients.set(c.clientId, c);
  }
  async upsertClient(c: OAuthClient) {
    const prev = this.clients.get(c.clientId);
    const { logo, ...rest } = c;
    let logoHash = prev?.logoHash;
    if (logo === null) logoHash = undefined;
    if (logo) {
      this.logos.set(logo.hash, logo);
      logoHash = logo.hash;
    }
    this.clients.set(c.clientId, { ...rest, createdAt: prev?.createdAt ?? c.createdAt, ...(logoHash ? { logoHash } : {}) });
  }
  async getClient(id: string) {
    return this.clients.get(id) ?? null;
  }
  async getClientLogo(hash: string) {
    const l = this.logos.get(hash);
    return l ? { mime: l.mime, bytes: l.bytes } : null;
  }
  async savePending(p: PendingAuthorization) {
    this.pending.set(p.id, p);
  }
  async getPending(id: string) {
    return this.pending.get(id) ?? null;
  }
  async deletePending(id: string) {
    this.pending.delete(id);
  }
  async saveCode(c: AuthCode) {
    this.codes.set(c.code, c);
  }
  async takeCode(code: string) {
    const c = this.codes.get(code);
    this.codes.delete(code);
    return c && c.expiresAt > Date.now() ? c : null;
  }
  async saveToken(t: TokenRecord) {
    this.tokens.set(t.tokenHash, { createdAt: Date.now(), ...t });
  }
  async getToken(hash: string) {
    const t = this.tokens.get(hash);
    return t && t.expiresAt > Date.now() ? t : null;
  }
  async deleteToken(hash: string) {
    this.tokens.delete(hash);
  }
  async listTokens(userId: string) {
    return [...this.tokens.values()].filter((t) => t.userId === userId && t.expiresAt > Date.now());
  }
  async deleteTokensOfClient(userId: string, clientId: string) {
    for (const [h, t] of this.tokens) if (t.userId === userId && t.clientId === clientId) this.tokens.delete(h);
  }
  async touchToken(hash: string, lastUsedAt: number, expiresAt?: number) {
    const t = this.tokens.get(hash);
    if (t) this.tokens.set(hash, { ...t, lastUsedAt, ...(expiresAt ? { expiresAt } : {}) });
  }
}

/** Usuários em memória (testes). */
export class MemoryUserDirectory implements UserDirectory {
  private byEmail = new Map<string, string>();
  async findOrCreateByEmail(email: string) {
    const key = email.trim().toLowerCase();
    let id = this.byEmail.get(key);
    if (!id) {
      id = `user-${this.byEmail.size + 1}`;
      this.byEmail.set(key, id);
    }
    return { id };
  }
  async findProfile(userId: string) {
    for (const [email, id] of this.byEmail) if (id === userId) return { id, email, name: null };
    return null;
  }
}
const NAO_LIGADO: LinkStatus = { connected: false };

/** Placeholder: o módulo Google ainda não entregou o vínculo. */
export class StubGoogleLink implements GoogleLinkPort {
  loginEnabled(): boolean {
    return false;
  }
  async startLoginUrl(): Promise<string> {
    throw new Error('Login com Google ainda não disponível');
  }
  async handleLoginCallback(): Promise<{ email: string }> {
    throw new Error('Login com Google ainda não disponível');
  }
}

/** Classroom configurado, sem conta conectada. */
export class StubClassroomLink implements ClassroomLinkPort {
  enabled() {
    return true;
  }
  apps(): ('ufba' | 'convidado')[] {
    return ['ufba', 'convidado'];
  }
  async contas(): Promise<string[]> {
    return [];
  }
  async startUrl(): Promise<string> {
    throw new Error('Vínculo com o Classroom ainda não disponível');
  }
  async handleCallback(): Promise<{ email: string }> {
    throw new Error('Vínculo com o Classroom ainda não disponível');
  }
}

/** Placeholder: o módulo Moodle ainda não entregou o vínculo (spike do redirect aberto). */
export class StubMoodleLink implements MoodleLinkPort {
  async status() {
    return NAO_LIGADO;
  }
  host() {
    return 'moodle.example';
  }
  scheme() {
    return 'web+ufba';
  }
  async launchUrl(): Promise<string> {
    return 'https://moodle.example/admin/tool/mobile/launch.php';
  }
  async connect(): Promise<void> {
    throw new Error('Vínculo com o Moodle ainda não disponível');
  }
}

/** Stub do SIGAA: guarda a senha só em memória do teste e aceita qualquer coisa, exceto a senha "errada". */
export class StubSigaaLink implements SigaaLinkPort {
  private readonly pend = new Set<string>();
  async conectar(txn: string, login: string, senha: string): Promise<void> {
    if (!login || senha === 'errada') throw new Error('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
    this.pend.add(txn);
  }
  pendente(txn: string): boolean {
    return this.pend.has(txn);
  }
  async validar(_chave: string, login: string, senha: string): Promise<string> {
    if (!login.trim() || senha === 'errada') {
      throw new LinkError('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
    }
    return login.trim();
  }
}
