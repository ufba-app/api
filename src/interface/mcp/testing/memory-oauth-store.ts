import {
  AuthCode,
  ClassroomLinkPort,
  GoogleLinkPort,
  LinkStatus,
  MoodleLinkPort,
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
  SigaaLinkPort,
  TokenRecord,
  UserDirectory,
} from '../../../application/oauth/oauth-ports';

/** Store em memória: some ao reiniciar (clientes e tokens precisam ser refeitos). Trocar por persistência do Núcleo. */
export class MemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, TokenRecord>();

  async saveClient(c: OAuthClient) {
    this.clients.set(c.clientId, c);
  }
  async getClient(id: string) {
    return this.clients.get(id) ?? null;
  }
  async savePending(p: PendingAuthorization) {
    this.pending.set(p.id, p);
  }
  async getPending(id: string) {
    const p = this.pending.get(id);
    return p && p.expiresAt > Date.now() ? p : null;
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
    this.tokens.set(t.tokenHash, t);
  }
  async getToken(hash: string) {
    const t = this.tokens.get(hash);
    return t && t.expiresAt > Date.now() ? t : null;
  }
  async deleteToken(hash: string) {
    this.tokens.delete(hash);
  }
}

/** Usuários em memória até o UserRepository do Núcleo. */
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
}
