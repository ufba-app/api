import { ApiError } from '../web/web-api';
import { GrantReconciler } from './grant-reconciler';
import { GrantLevel } from './memory-ports';
import { MemoryProjectRepository, MemorySyncJobRepository, TeamGrantSource } from './project-ports';
import { TeamRoleRepository, UserLister } from './team-ports';

const LEVEL: Record<GrantLevel, number> = { read: 1, write: 2 };

/** Concessões vindas dos papéis: por projeto, vale o maior nível entre os papéis da pessoa. */
export class DbTeamGrantSource extends TeamGrantSource {
  constructor(private readonly roles: TeamRoleRepository) {
    super();
  }

  async grantsFor(userId: string): Promise<{ projectId: string; level: GrantLevel }[]> {
    const mine = new Set(await this.roles.rolesOf(userId));
    if (mine.size === 0) return [];
    const best = new Map<string, GrantLevel>();
    for (const r of await this.roles.listRoles()) {
      if (!mine.has(r.key)) continue;
      for (const g of r.grants) {
        const cur = best.get(g.projectId);
        if (!cur || LEVEL[g.level] > LEVEL[cur]) best.set(g.projectId, g.level);
      }
    }
    return [...best].map(([projectId, level]) => ({ projectId, level }));
  }

  async involvedUserIds(): Promise<string[]> {
    return [...new Set((await this.roles.listAssignments()).map((a) => a.userId))];
  }
}

/** Quem é administrador da memória: e-mails de `MEMORY_ADMIN_EMAILS` (não é tabela editável por outros). */
export class MemoryAdmins {
  constructor(
    private readonly directory: { findProfile(id: string): Promise<{ email: string | null } | null> },
    private readonly emails: ReadonlySet<string>,
  ) {}

  static parse(raw: string | undefined): Set<string> {
    return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  }

  async isAdmin(userId: string): Promise<boolean> {
    if (this.emails.size === 0) return false;
    const email = (await this.directory.findProfile(userId))?.email;
    return Boolean(email && this.emails.has(email.toLowerCase()));
  }

  async require(userId: string): Promise<void> {
    if (!(await this.isAdmin(userId))) throw new ApiError(403, 'not_admin', 'Só administradores podem fazer isso.');
  }
}

export interface TeamOverview {
  roles: { key: string; description: string; grants: { workspace: string; project: string; title: string; level: GrantLevel }[] }[];
  members: { userId: string; name: string | null; email: string | null; roles: string[] }[];
}

export interface SyncOverview {
  failing: { name: string | null; email: string | null; attempts: number; nextRunAt: Date; lastError: string | null }[];
  unknownProjects: { workspace: string; project: string }[];
}

/** Administração: ver papéis (somente leitura), atribuir e retirar papel por pessoa, e a fila de sincronização. */
export class TeamRoles {
  constructor(
    private readonly admins: MemoryAdmins,
    private readonly roles: TeamRoleRepository,
    private readonly lister: UserLister,
    private readonly projects: MemoryProjectRepository,
    private readonly jobs: MemorySyncJobRepository,
    private readonly reconciler: GrantReconciler,
    private readonly directory: { findProfile(id: string): Promise<{ name: string | null; email: string | null } | null> },
  ) {}

  async overview(adminId: string): Promise<TeamOverview> {
    await this.admins.require(adminId);
    const byProject = new Map((await this.projects.listAll()).map((p) => [p.id, p]));
    const rolesOfUser = new Map<string, string[]>();
    for (const a of await this.roles.listAssignments()) {
      rolesOfUser.set(a.userId, [...(rolesOfUser.get(a.userId) ?? []), a.roleKey]);
    }
    const people = await this.lister.list(500);
    return {
      roles: (await this.roles.listRoles()).map((r) => ({
        key: r.key,
        description: r.description,
        grants: r.grants.flatMap((g) => {
          const p = byProject.get(g.projectId);
          return p ? [{ workspace: p.workspace, project: p.project, title: p.title, level: g.level }] : [];
        }),
      })),
      members: people.map((u) => ({ userId: u.id, name: u.name, email: u.email, roles: (rolesOfUser.get(u.id) ?? []).sort() })),
    };
  }

  async assign(adminId: string, userId: string, roleKey: string): Promise<void> {
    await this.admins.require(adminId);
    await this.check(userId, roleKey);
    await this.roles.assign(userId, roleKey, adminId);
    await this.reconciler.syncUser(userId); // concede; falha vira job ("sincronizando")
  }

  async unassign(adminId: string, userId: string, roleKey: string): Promise<void> {
    await this.admins.require(adminId);
    await this.check(userId, roleKey);
    await this.roles.unassign(userId, roleKey);
    await this.reconciler.syncUser(userId); // revoga só o que mais nenhum convite/papel sustenta
  }

  async sync(adminId: string): Promise<SyncOverview> {
    await this.admins.require(adminId);
    const failing = await Promise.all(
      (await this.jobs.listAll(100)).map(async (j) => {
        const p = await this.directory.findProfile(j.userId);
        return { name: p?.name ?? null, email: p?.email ?? null, attempts: j.attempts, nextRunAt: j.nextRunAt, lastError: j.lastError };
      }),
    );
    return { failing, unknownProjects: await this.reconciler.unknownProjects().catch(() => []) };
  }

  private async check(userId: string, roleKey: string): Promise<void> {
    if (!(await this.roles.listRoles()).some((r) => r.key === roleKey)) {
      throw new ApiError(404, 'role_not_found', 'Papel não encontrado.');
    }
    if (!(await this.directory.findProfile(userId))) throw new ApiError(404, 'not_found', 'Pessoa não encontrada.');
  }
}
