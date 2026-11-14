import { GrantLevel, MemoryAdmin, MemoryAdminError, MemoryProjectInfo } from './memory-ports';
import { memoryUsernameOf, MemoryUsers } from './memory-users';
import {
  MemoryGrantSync,
  MemoryProjectRepository,
  MemorySyncJobRepository,
  ProjectRecord,
  TeamGrantSource,
} from './project-ports';

export type EffectiveSource = 'owner' | 'invite' | 'team';

export interface Effective {
  project: ProjectRecord;
  level: GrantLevel;
  source: EffectiveSource;
}

const RANK: Record<GrantLevel, number> = { read: 1, write: 2 };
const SOURCE_PRIORITY: Record<EffectiveSource, number> = { owner: 3, invite: 2, team: 1 };

const keyOf = (workspace: string, project: string) => `${workspace}/${project}`;

/** Atraso da próxima tentativa: 30 s, 1 min, 2 min... até 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export interface ReconcilerDeps {
  admin: MemoryAdmin;
  users: MemoryUsers;
  projects: MemoryProjectRepository;
  jobs: MemorySyncJobRepository;
  team: TeamGrantSource;
  /** E-mail da pessoa (para ligar convites pendentes ao primeiro login). */
  emailOf: (userId: string) => Promise<string | null>;
  now?: () => number;
}

/**
 * Reconciliação (idempotente): por pessoa, calcula o nível efetivo em cada projeto (o MAIOR entre dono, convite direto
 * e papel do time), compara com os grants do memory e emite só o que diverge. Falha vira job com backoff
 * (`memory_sync_jobs`); a tela mostra "sincronizando". Só mexe em projetos que a ufba.app gerencia.
 */
export class GrantReconciler extends MemoryGrantSync {
  private readonly now: () => number;

  constructor(private readonly d: ReconcilerDeps) {
    super();
    this.now = d.now ?? Date.now;
  }

  /** Níveis efetivos da pessoa. Liga antes os convites pendentes feitos ao e-mail dela. */
  async effectiveFor(userId: string): Promise<Effective[]> {
    await this.bindPending(userId);
    const byProject = new Map<string, Effective>();
    const offer = (project: ProjectRecord, level: GrantLevel, source: EffectiveSource) => {
      const cur = byProject.get(project.id);
      const better =
        !cur ||
        RANK[level] > RANK[cur.level] ||
        (RANK[level] === RANK[cur.level] && SOURCE_PRIORITY[source] > SOURCE_PRIORITY[cur.source]);
      if (better) byProject.set(project.id, { project, level, source });
    };

    const all = new Map((await this.d.projects.listAll()).map((p) => [p.id, p]));
    for (const p of all.values()) if (p.ownerId === userId) offer(p, 'write', 'owner');
    for (const m of await this.d.projects.listMembershipsOf(userId)) {
      const p = all.get(m.projectId);
      if (p && m.status === 'active') offer(p, m.level, 'invite');
    }
    for (const g of await this.d.team.grantsFor(userId)) {
      const p = all.get(g.projectId);
      if (p) offer(p, g.level, 'team');
    }
    return [...byProject.values()];
  }

  private async bindPending(userId: string): Promise<void> {
    const email = await this.d.emailOf(userId);
    if (!email) return;
    for (const m of await this.d.projects.listPendingByEmail(email.toLowerCase())) {
      await this.d.projects.bindMember(m.projectId, m.email, userId);
    }
  }

  /** Reconcilia uma pessoa. Devolve false (e agenda nova tentativa) se o memory não deu conta. */
  async syncUser(userId: string): Promise<boolean> {
    if (!this.d.admin.isConfigured()) return true;
    try {
      await this.reconcile(userId);
      await this.d.jobs.clear(userId);
      return true;
    } catch (e) {
      if (e instanceof MemoryAdminError && e.kind === 'forbidden' && (await this.isDisabled(userId))) {
        await this.d.jobs.clear(userId);
        return true;
      }
      const prev = await this.d.jobs.find(userId);
      const attempts = (prev?.attempts ?? 0) + 1;
      const code = e instanceof MemoryAdminError ? `${e.kind}${e.status ? `:${e.status}` : ''}` : 'error';
      await this.d.jobs.schedule(userId, attempts, new Date(this.now() + backoffMs(attempts)), code);
      return false;
    }
  }

  /** Como `syncUser`, mas propaga a falha (exclusão de conta não pode seguir com acesso aberto). */
  async syncUserStrict(userId: string): Promise<void> {
    if (!this.d.admin.isConfigured()) return;
    await this.reconcile(userId);
    await this.d.jobs.clear(userId);
  }

  private async isDisabled(userId: string): Promise<boolean> {
    return this.d.users.isDisabled(userId);
  }

  private async reconcile(userId: string): Promise<void> {
    const desired = await this.effectiveFor(userId);
    const ready = await this.d.users.isReady(userId);
    if (!ready && desired.length === 0) return;
    const { username } = await this.d.users.ensure(userId);

    const managed = new Set((await this.d.projects.listAll()).map((p) => keyOf(p.workspace, p.project)));
    const actual = (await this.d.admin.listGrants(username)).filter((g) => managed.has(keyOf(g.workspace, g.project)));
    const want = new Map(desired.map((e) => [keyOf(e.project.workspace, e.project.project), e]));

    for (const [k, e] of want) {
      const have = actual.find((g) => keyOf(g.workspace, g.project) === k);
      if (have?.level === e.level) continue;
      // Projeto sempre `restricted` antes do primeiro grant (cinto e suspensório do NEW_PROJECTS_RESTRICTED).
      await this.d.admin.setProjectAccess(e.project.workspace, e.project.project, 'restricted');
      await this.d.admin.grant(username, e.project.workspace, e.project.project, e.level);
    }
    for (const g of actual) {
      if (!want.has(keyOf(g.workspace, g.project))) await this.d.admin.revokeGrant(username, g.workspace, g.project);
    }
  }

  /** Jobs vencidos (retentativa com backoff). Devolve quantos deram certo. */
  async runDue(limit = 50): Promise<number> {
    let ok = 0;
    for (const j of await this.d.jobs.listDue(new Date(this.now()), limit)) if (await this.syncUser(j.userId)) ok++;
    return ok;
  }

  /** Projetos do time existem no memory como `restricted` antes de qualquer pessoa (S12). */
  async ensureTeamProjects(): Promise<void> {
    if (!this.d.admin.isConfigured()) return;
    for (const p of await this.d.projects.listAll()) {
      if (p.ownerId === null) await this.d.admin.setProjectAccess(p.workspace, p.project, 'restricted');
    }
  }

  /** Projetos nos workspaces `ufba-*` que existem no memory mas a ufba.app não conhece (criados por escrita direta, S12). */
  async unknownProjects(): Promise<MemoryProjectInfo[]> {
    if (!this.d.admin.isConfigured()) return [];
    const known = new Set((await this.d.projects.listAll()).map((p) => keyOf(p.workspace, p.project)));
    return (await this.d.admin.listProjects()).filter(
      (p) => p.workspace.startsWith('ufba-') && !known.has(keyOf(p.workspace, p.project)),
    );
  }

  /** Pessoas que a varredura precisa reconciliar. */
  async involvedUserIds(): Promise<string[]> {
    return [...new Set([...(await this.d.projects.listInvolvedUserIds()), ...(await this.d.team.involvedUserIds())])];
  }

  /** O nome de usuário no memory (determinístico), para quem só precisa dele. */
  usernameOf(userId: string): string {
    return memoryUsernameOf(userId);
  }
}
