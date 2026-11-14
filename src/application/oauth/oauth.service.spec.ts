import { createHash } from 'node:crypto';
import type { AuthCode, ChaveDoClientePort, OAuthClient, OAuthStore, PendingAuthorization, TokenRecord } from './oauth-ports';
import { OAuthAccessTokenAuthenticator, OAuthService, splitToken } from './oauth.service';
import { sha256Base64Url } from './pkce';

const VERIFIER = 'a'.repeat(50);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://localhost:9999/callback';
const K = Buffer.alloc(32, 7);
const K_B64 = K.toString('base64url');

class StoreEspia implements OAuthStore {
  salvos: TokenRecord[] = [];
  private clients = new Map<string, OAuthClient>();
  private pendings = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, TokenRecord>();
  async saveClient(c: OAuthClient) { this.clients.set(c.clientId, c); }
  async getClient(id: string) { return this.clients.get(id) ?? null; }
  async savePending(p: PendingAuthorization) { this.pendings.set(p.id, p); }
  async getPending(id: string) { return this.pendings.get(id) ?? null; }
  async deletePending(id: string) { this.pendings.delete(id); }
  async claimPending(id: string, u: string) {
    const p = this.pendings.get(id);
    if (!p || (p.userId && p.userId !== u)) return false;
    this.pendings.set(id, { ...p, userId: u });
    return true;
  }
  async takePending(id: string) {
    const p = this.pendings.get(id) ?? null;
    this.pendings.delete(id);
    return p;
  }
  async saveCode(c: AuthCode) { this.codes.set(c.code, c); }
  async takeCode(code: string) {
    const c = this.codes.get(code) ?? null;
    this.codes.delete(code);
    return c;
  }
  async saveToken(t: TokenRecord) {
    this.salvos.push(t);
    this.tokens.set(t.tokenHash, t);
  }
  async getToken(h: string) { return this.tokens.get(h) ?? null; }
  async deleteToken(h: string) { this.tokens.delete(h); }
  async upsertClient(c: OAuthClient) { this.clients.set(c.clientId, c); }
  async getClientLogo() { return null; }
  async listTokens(u: string) { return [...this.tokens.values()].filter((t) => t.userId === u); }
  async deleteTokensOfClient(u: string, c: string) {
    for (const [h, t] of this.tokens) if (t.userId === u && t.clientId === c) this.tokens.delete(h);
  }
  async touchToken(h: string, lastUsedAt: number, expiresAt?: number) {
    const t = this.tokens.get(h);
    if (t) this.tokens.set(h, { ...t, lastUsedAt, ...(expiresAt ? { expiresAt } : {}) });
  }
}

function montar(chaves?: Partial<ChaveDoClientePort>, store: OAuthStore = new StoreEspia()) {
  const porta: ChaveDoClientePort = {
    vincularCodigo: jest.fn(),
    gravarNoToken: jest.fn(async () => K),
    ...chaves,
  };
  const users = {
    findOrCreateByEmail: jest.fn(async () => ({ id: 'u1' })),
    findByEmail: jest.fn(async () => null),
    findProfile: jest.fn(async () => null),
    deleteAccount: jest.fn(async () => undefined),
  };
  return { porta, store, svc: new OAuthService(store, users, Date.now, porta) };
}

async function emitirCode(svc: OAuthService) {
  const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
  const p = await svc.begin({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });
  await svc.identify(p.id, 'a@b.com');
  const url = new URL(await svc.complete(p.id));
  return { clientId: c.clientId, txn: p.id, code: url.searchParams.get('code')! };
}

const trocar = (svc: OAuthService, clientId: string, code: string) =>
  svc.token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: VERIFIER });

describe('OAuthService com a chave do cliente', () => {
  it('complete chama vincularCodigo(txn, sha256(code))', async () => {
    const { svc, porta } = montar();
    const { txn, code } = await emitirCode(svc);
    expect(porta.vincularCodigo).toHaveBeenCalledWith(txn, sha256Base64Url(code));
  });

  it('fromCode com pendente devolve tokens com sufixo .K e o mesmo K nos dois', async () => {
    const { svc, porta } = montar();
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    expect(t.access_token.endsWith('.' + K_B64)).toBe(true);
    expect(t.refresh_token.endsWith('.' + K_B64)).toBe(true);
    expect(porta.gravarNoToken).toHaveBeenCalledWith(sha256Base64Url(code), { userId: 'u1', clientId });
  });

  it('fromRefresh preserva K do refresh apresentado no par novo', async () => {
    const { svc } = montar();
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    const r = await svc.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(r.access_token.endsWith('.' + K_B64)).toBe(true);
    expect(r.refresh_token.endsWith('.' + K_B64)).toBe(true);
    expect(r.refresh_token).not.toBe(t.refresh_token);
  });

  it('sem pendente (servidor reiniciado), fromCode devolve tokens sem K e não falha', async () => {
    const { svc } = montar({ gravarNoToken: jest.fn(async () => null) });
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    expect(t.access_token).not.toContain('.');
    expect(t.refresh_token).not.toContain('.');
  });

  it('se gravarNoToken rejeita, /token ainda emite tokens sem K', async () => {
    const { svc } = montar({ gravarNoToken: jest.fn(async () => { throw new Error('db'); }) });
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    expect(t.access_token).not.toContain('.');
  });

  it('sem porta (testes sem SIGAA) tudo segue funcionando', async () => {
    const svc = new OAuthService(new StoreEspia(), { findOrCreateByEmail: async () => ({ id: 'u1' }), findByEmail: async () => null, findProfile: async () => null, deleteAccount: async () => undefined });
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    expect(t.access_token).not.toContain('.');
  });

  it('verifyAccessToken devolve { userId, clientId, chave } e o store só viu o hash do token inteiro', async () => {
    const store = new StoreEspia();
    const { svc } = montar(undefined, store);
    const { clientId, code } = await emitirCode(svc);
    const t = await trocar(svc, clientId, code);
    const v = await svc.verifyAccessToken(t.access_token);
    expect(v?.userId).toBe('u1');
    expect(v?.clientId).toBe(clientId);
    expect(v?.chave?.equals(K)).toBe(true);
    expect(store.salvos.map((x) => x.tokenHash)).toContain(sha256Base64Url(t.access_token));
    expect(JSON.stringify(store.salvos)).not.toContain(K_B64);
    expect(await new OAuthAccessTokenAuthenticator(svc).authenticate(t.access_token)).toMatchObject({ clientId });
  });
});

describe('splitToken', () => {
  it('separa base e chave; sufixo inválido = sem chave', () => {
    expect(splitToken('abc.' + K_B64).chave?.equals(K)).toBe(true);
    expect(splitToken('abc.' + K_B64).base).toBe('abc');
    expect(splitToken('abc').chave).toBeUndefined();
    expect(splitToken('abc.curto').chave).toBeUndefined();
  });
});
