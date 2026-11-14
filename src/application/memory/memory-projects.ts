import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../web/web-api';
import { Effective, EffectiveSource, GrantReconciler } from './grant-reconciler';
import { GrantLevel, MemoryAdmin, MemoryAdminError } from './memory-ports';
import { MemoryUsers } from './memory-users';
import { MemoryProjectRepository, MemorySyncJobRepository, ProjectRecord } from './project-ports';

export const PROJECTS_WORKSPACE = 'ufba-alunos';

export interface UserLookup {
  findByEmail(email: string): Promise<{ id: string } | null>;
  findProfile(userId: string): Promise<{ id: string; email: string | null; name: string | null } | null>;
}

export interface ProjectView {
  id: string;
  workspace: string;
  project: string;
  title: string;
  /** Projeto do time (sem dono; as permissões vêm dos papéis). */
  team: boolean;
  role: 'owner' | GrantLevel;
  source: EffectiveSource;
  membersCount: number;
  sync: 'ok' | 'pending';
}

export interface MemberView {
  email: string;
  name: string | null;
  level: GrantLevel;
  status: 'pending' | 'active';
}

export interface ProjectDetail extends ProjectView {
  /** Só o dono vê a lista (e-mails dos colegas); os demais recebem vazio. */
  members: MemberView[];
  /** Trecho do `.ai-memory.toml` para colar na raiz do repositório. */
  marker: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const notFound = () => new ApiError(404, 'project_not_found', 'Projeto não encontrado.');
const notOwner = () =>
  new ApiError(403, 'not_project_owner', 'Só quem criou o projeto pode fazer isso.');

/** `Meu TCC: grafos!` → `meu-tcc-grafos`. */
export function slugOf(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return s || 'projeto';
}

function memoryDown(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(503, 'memory_unavailable', 'A memória está indisponível no momento. Tente de novo em instantes.');
}

export interface ProjectsDeps {
  projects: MemoryProjectRepository;
  jobs: MemorySyncJobRepository;
  reconciler: GrantReconciler;
  admin: MemoryAdmin;
  users: MemoryUsers;
  directory: UserLookup;
  /** Domínio aceito em convites (`ufba.br`). */
  domain: string;
  now?: () => number;
}

/**
 * Meus projetos: qualquer pessoa logada cria projetos (vira dona) e convida colegas @ufba.br com leitura ou escrita.
 * A ufba.app é a fonte da verdade; o ai-memory só reflete via grant/revoke (`GrantReconciler`). Só o dono gerencia.
 */
export class MemoryProjects {
  constructor(private readonly d: ProjectsDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  async list(userId: string): Promise<ProjectView[]> {
    const eff = await this.d.reconciler.effectiveFor(userId);
    const pending = Boolean(await this.d.jobs.find(userId));
    return Promise.all(eff.map((e) => this.view(e, pending)));
  }

  async detail(userId: string, id: string): Promise<ProjectDetail> {
    const e = await this.effective(userId, id);
    const view = await this.view(e, Boolean(await this.d.jobs.find(userId)));
    const members = e.source === 'owner' ? await this.members(id) : [];
    const p = e.project;
    return {
      ...view,
      members,
      marker: `workspace = "${p.workspace}"\nproject   = "${p.project}"\nserver    = "ufba"`,
    };
  }

  async create(userId: string, titleRaw: unknown): Promise<ProjectView> {
    const title = typeof titleRaw === 'string' ? titleRaw.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (!title) throw new ApiError(400, 'invalid_request', 'Informe um nome para o projeto.');
    if (await this.d.projects.titleTakenBy(userId, title)) {
      throw new ApiError(409, 'project_name_taken', 'Você já tem um projeto com esse nome.');
    }
    const slug = slugOf(title);
    let created: ProjectRecord | null = null;
    for (let i = 0; i < 6 && !created; i++) {
      const rec: ProjectRecord = {
        id: randomUUID(),
        workspace: PROJECTS_WORKSPACE,
        project: `${slug}-${randomBytes(2).toString('hex')}`,
        title,
        ownerId: userId,
        createdAt: new Date(this.now),
      };
      if (await this.d.projects.insert(rec)) created = rec;
    }
    if (!created) throw new ApiError(409, 'project_name_taken', 'Não foi possível gerar um identificador para o projeto. Tente de novo.');
    // Cria no memory como `restricted` e concede `write` à dona; se o memory não responder, fica "sincronizando".
    await this.d.reconciler.syncUser(userId);
    return this.view({ project: created, level: 'write', source: 'owner' }, Boolean(await this.d.jobs.find(userId)));
  }

  /** Convida (ou muda o nível de) um e-mail @ufba.br. Sem conta ainda: fica `pending` e vale no primeiro login. */
  async setMember(ownerId: string, id: string, emailRaw: string, level: GrantLevel): Promise<void> {
    const project = await this.owned(ownerId, id);
    const email = this.normalizeEmail(emailRaw);
    const owner = await this.d.directory.findProfile(ownerId);
    if (owner?.email && owner.email.toLowerCase() === email) {
      throw new ApiError(400, 'invalid_request', 'Você já é dona ou dono do projeto.');
    }
    const user = await this.d.directory.findByEmail(email);
    const prev = await this.d.projects.findMember(id, email);
    await this.d.projects.upsertMember({
      projectId: id,
      email,
      userId: user?.id ?? null,
      level,
      status: user ? 'active' : 'pending',
      invitedBy: ownerId,
      createdAt: prev?.createdAt ?? new Date(this.now),
    });
    if (user) await this.d.reconciler.syncUser(user.id);
    void project;
  }

  /** O dono remove um membro; o membro pode sair (o próprio e-mail). O dono não sai sem transferir. */
  async removeMember(actorId: string, id: string, emailRaw: string): Promise<void> {
    const e = await this.effective(actorId, id);
    const email = this.normalizeEmail(emailRaw);
    const me = (await this.d.directory.findProfile(actorId))?.email?.toLowerCase();
    const owner = e.source === 'owner';
    if (!owner && me !== email) throw notOwner();
    if (owner && me === email) {
      throw new ApiError(400, 'invalid_request', 'O dono não pode sair: transfira o projeto ou apague-o.');
    }
    if (e.project.ownerId === null) throw notOwner();
    const m = await this.d.projects.findMember(id, email);
    if (!m) throw notFound();
    await this.d.projects.deleteMember(id, email);
    if (m.userId) await this.d.reconciler.syncUser(m.userId);
  }

  /** Passa a posse a um membro ativo com `write`; quem transferiu continua com `write`. */
  async transfer(ownerId: string, id: string, emailRaw: string): Promise<void> {
    await this.owned(ownerId, id);
    const email = this.normalizeEmail(emailRaw);
    const target = await this.d.projects.findMember(id, email);
    if (!target || target.status !== 'active' || !target.userId || target.level !== 'write') {
      throw new ApiError(400, 'invalid_request', 'A posse só passa para um membro com permissão de escrita.');
    }
    const oldOwner = await this.d.directory.findProfile(ownerId);
    await this.d.projects.setOwner(id, target.userId);
    await this.d.projects.deleteMember(id, email);
    if (oldOwner?.email) {
      await this.d.projects.upsertMember({
        projectId: id,
        email: oldOwner.email.toLowerCase(),
        userId: ownerId,
        level: 'write',
        status: 'active',
        invitedBy: target.userId,
        createdAt: new Date(this.now),
      });
    }
    await this.d.reconciler.syncUser(target.userId);
    await this.d.reconciler.syncUser(ownerId);
  }

  /** Apaga o projeto no memory (conteúdo e acessos) e aqui. Só o dono; projeto do time não. */
  async remove(ownerId: string, id: string): Promise<void> {
    const project = await this.owned(ownerId, id);
    await this.purge(project);
  }

  /** Apaga no memory e depois aqui. Se o memory falhar, nada é apagado aqui (nada fica órfão no memory). */
  async purge(project: ProjectRecord): Promise<void> {
    const involved = new Set<string>();
    if (project.ownerId) involved.add(project.ownerId);
    for (const m of await this.d.projects.listMembers(project.id)) if (m.userId) involved.add(m.userId);
    if (this.d.admin.isConfigured()) {
      try {
        for (const uid of involved) {
          if (!(await this.d.users.isReady(uid))) continue;
          const { username } = await this.d.users.ensure(uid);
          await this.d.admin.revokeGrant(username, project.workspace, project.project).catch((e: unknown) => {
            if (!(e instanceof MemoryAdminError && e.kind === 'not_found')) throw e;
          });
        }
        await this.d.admin.purgeProject(project.workspace, project.project).catch((e: unknown) => {
          if (!(e instanceof MemoryAdminError && e.kind === 'not_found')) throw e;
        });
      } catch (e) {
        throw memoryDown(e);
      }
    }
    await this.d.projects.delete(project.id);
  }

  // ---- internos ----

  private normalizeEmail(raw: string): string {
    const email = String(raw ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || !email.endsWith(`@${this.d.domain}`)) {
      throw new ApiError(400, 'invalid_email_domain', `Só e-mails @${this.d.domain} podem ser convidados.`);
    }
    return email;
  }

  /** Projeto da pessoa (dona, convidada ou do time); outro caso = 404 (não confirma que existe). */
  private async effective(userId: string, id: string): Promise<Effective> {
    const found = (await this.d.reconciler.effectiveFor(userId)).find((e) => e.project.id === id);
    if (!found) throw notFound();
    return found;
  }

  private async owned(userId: string, id: string): Promise<ProjectRecord> {
    const e = await this.effective(userId, id);
    if (e.project.ownerId !== userId) throw notOwner();
    return e.project;
  }

  private async members(id: string): Promise<MemberView[]> {
    const rows = await this.d.projects.listMembers(id);
    return Promise.all(
      rows.map(async (m) => ({
        email: m.email,
        name: m.userId ? ((await this.d.directory.findProfile(m.userId))?.name ?? null) : null,
        level: m.level,
        status: m.status,
      })),
    );
  }

  private async view(e: Effective, pending: boolean): Promise<ProjectView> {
    const rows = await this.d.projects.listMembers(e.project.id);
    const active = rows.filter((m) => m.status === 'active').length + (e.project.ownerId ? 1 : 0);
    return {
      id: e.project.id,
      workspace: e.project.workspace,
      project: e.project.project,
      title: e.project.title,
      team: e.project.ownerId === null,
      role: e.source === 'owner' ? 'owner' : e.level,
      source: e.source,
      membersCount: active,
      sync: pending ? 'pending' : 'ok',
    };
  }
}
