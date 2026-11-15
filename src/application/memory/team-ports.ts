import type { GrantLevel } from './memory-ports';

export interface TeamRoleRecord {
  key: string;
  description: string;
  grants: { projectId: string; level: GrantLevel }[];
}

/** Papéis (configuração, só leitura) e atribuição por pessoa (a única parte que muda, só pelo admin). */
export abstract class TeamRoleRepository {
  abstract listRoles(): Promise<TeamRoleRecord[]>;
  abstract rolesOf(userId: string): Promise<string[]>;
  abstract listAssignments(): Promise<{ userId: string; roleKey: string }[]>;
  abstract assign(userId: string, roleKey: string, assignedBy: string): Promise<void>;
  /** false se a pessoa não tinha o papel. */
  abstract unassign(userId: string, roleKey: string): Promise<boolean>;
}

/** Lista de pessoas (para o admin escolher quem recebe papel). */
export abstract class UserLister {
  abstract list(limit: number): Promise<{ id: string; name: string | null; email: string | null }[]>;
  /** Busca por parte do nome ou do e-mail (sem diferenciar maiúsculas), no máximo `limit` pessoas. */
  abstract search(query: string, limit: number): Promise<{ id: string; name: string | null; email: string | null }[]>;
  /** Pessoas por id (para listar quem tem papel sem varrer todo mundo). */
  abstract byIds(ids: string[]): Promise<{ id: string; name: string | null; email: string | null }[]>;
}
