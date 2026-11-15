import { UserPermissionRepository, type UserPermissionRow } from '../../src/application/ports/permissions';

/** Permissões por pessoa em memória (mesma semântica do Postgres: chave primária (userId, key); sem linha = desligado). */
export class InMemoryPermissions extends UserPermissionRepository {
  rows = new Map<string, { enabled: boolean; updatedAt: Date }>();
  private k = (userId: string, key: string) => `${userId}|${key}`;

  async list(userId: string): Promise<UserPermissionRow[]> {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${userId}|`))
      .map(([k, v]) => ({ key: k.slice(userId.length + 1), enabled: v.enabled }));
  }
  async set(userId: string, key: string, enabled: boolean, at: Date) {
    this.rows.set(this.k(userId, key), { enabled, updatedAt: at });
  }
  async deleteBySource(userId: string, source: string) {
    for (const k of [...this.rows.keys()]) if (k.startsWith(`${userId}|${source}.`)) this.rows.delete(k);
  }
}
