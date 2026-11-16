import { ClientPermissionRepository, type ClientPermissionRow } from '../../src/application/ports/permissions';

/** Permissões por app em memória (mesma semântica do Postgres: chave primária (userId, clientId, key); sem linha = negada). */
export class InMemoryPermissions extends ClientPermissionRepository {
  /** `userId|clientId|key` → quando foi concedida. */
  rows = new Map<string, Date>();
  private k = (userId: string, clientId: string, key: string) => `${userId}|${clientId}|${key}`;
  private parsed(userId: string): ClientPermissionRow[] {
    return [...this.rows.keys()]
      .filter((k) => k.startsWith(`${userId}|`))
      .map((k) => {
        const [, clientId, ...key] = k.split('|');
        return { clientId, key: key.join('|') };
      });
  }

  async keysOf(userId: string, clientId: string) {
    return this.parsed(userId).filter((r) => r.clientId === clientId).map((r) => r.key);
  }
  async listByUser(userId: string) {
    return this.parsed(userId);
  }
  async replace(userId: string, clientId: string, keys: readonly string[], at: Date) {
    await this.deleteClient(userId, clientId);
    for (const key of keys) this.rows.set(this.k(userId, clientId, key), at);
  }
  async revoke(userId: string, clientId: string, key: string) {
    return this.rows.delete(this.k(userId, clientId, key));
  }
  async revokeEverywhere(userId: string, key: string) {
    for (const r of this.parsed(userId)) if (r.key === key) this.rows.delete(this.k(userId, r.clientId, key));
  }
  async deleteClient(userId: string, clientId: string) {
    for (const r of this.parsed(userId)) if (r.clientId === clientId) this.rows.delete(this.k(userId, clientId, r.key));
  }
  async deleteBySource(userId: string, source: string) {
    for (const r of this.parsed(userId)) if (r.key.startsWith(`${source}.`)) this.rows.delete(this.k(userId, r.clientId, r.key));
  }
}
