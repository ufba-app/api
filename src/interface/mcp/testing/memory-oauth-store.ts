import {
  AuthCode,
  GoogleLinkPort,
  LinkStatus,
  MoodleLinkPort,
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
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
  async status() {
    return NAO_LIGADO;
  }
  async startUrl(): Promise<string> {
    throw new Error('Vínculo com o Google ainda não disponível');
  }
  async handleCallback(): Promise<void> {
    throw new Error('Vínculo com o Google ainda não disponível');
  }
}

/** Placeholder: o módulo Moodle ainda não entregou o vínculo (spike do redirect aberto). */
export class StubMoodleLink implements MoodleLinkPort {
  async status() {
    return NAO_LIGADO;
  }
  async startUrl(): Promise<string> {
    throw new Error('Vínculo com o Moodle ainda não disponível');
  }
  async handleReturn(): Promise<void> {
    throw new Error('Vínculo com o Moodle ainda não disponível');
  }
}
