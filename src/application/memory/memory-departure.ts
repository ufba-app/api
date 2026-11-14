import { ApiError } from '../web/web-api';
import { GrantReconciler } from './grant-reconciler';
import { MemoryComputers } from './memory-computers';
import { MemoryProjects } from './memory-projects';
import { MemoryAdmin, MemoryAdminError } from './memory-ports';
import { memoryUsernameOf, MemoryUsers } from './memory-users';
import { MemoryProjectRepository } from './project-ports';

export const EX_PARTICIPANT = 'Ex-participante';

/** O que roda antes de excluir a conta (`DELETE /me`). */
export abstract class AccountDeparture {
  abstract run(userId: string): Promise<void>;
}

/**
 * Saída de uma pessoa (§4.4), nesta ordem: (1) revoga todas as chaves (computadores e repasse); (2) projetos que eram
 * só dela somem; (3) projetos compartilhados passam à pessoa ativa mais antiga com escrita (sem escrita, à mais antiga
 * ativa, que ganha escrita: o conteúdo fica com o projeto); (4) convites e acessos dela são removidos; (5) o usuário
 * no memory é desativado e perde o nome ("Ex-participante"). Falha do memory interrompe a exclusão (a pessoa tenta de
 * novo; cada passo é idempotente): nunca deixa chave ou acesso aberto para trás.
 */
export class MemoryDeparture extends AccountDeparture {
  constructor(
    private readonly admin: MemoryAdmin,
    private readonly users: MemoryUsers,
    private readonly computers: MemoryComputers,
    private readonly projects: MemoryProjectRepository,
    private readonly projectService: MemoryProjects,
    private readonly reconciler: GrantReconciler,
  ) {
    super();
  }

  async run(userId: string): Promise<void> {
    const configured = this.admin.isConfigured();
    const ready = configured && (await this.users.isReady(userId));
    try {
      if (ready) {
        await this.computers.revokeAll(userId);
        await this.users.revokeProxyKey(userId);
      }
      await this.handOverOrDeleteProjects(userId);
      for (const m of await this.projects.listMembershipsOf(userId)) await this.projects.deleteMember(m.projectId, m.email);
      if (ready) {
        // Sem projeto nem convite, o desejado é vazio: o reconciliador revoga todo grant que sobrou.
        await this.reconciler.syncUserStrict(userId);
        const username = memoryUsernameOf(userId);
        await this.admin.renameUser(username, EX_PARTICIPANT).catch(ignoreNotFound);
        await this.admin.disableUser(username).catch(ignoreNotFound);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, 'memory_unavailable', 'A memória está indisponível agora. Tente excluir a conta de novo em instantes.');
    }
  }

  private async handOverOrDeleteProjects(userId: string): Promise<void> {
    for (const project of await this.projects.listOwnedBy(userId)) {
      const others = (await this.projects.listMembers(project.id))
        .filter((m) => m.status === 'active' && m.userId && m.userId !== userId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (others.length === 0) {
        await this.projectService.purge(project); // pessoal: some no memory e aqui
        continue;
      }
      const heir = others.find((m) => m.level === 'write') ?? others[0];
      await this.projects.setOwner(project.id, heir.userId!);
      await this.projects.deleteMember(project.id, heir.email);
      await this.reconciler.syncUser(heir.userId!);
    }
  }
}

function ignoreNotFound(e: unknown): void {
  if (!(e instanceof MemoryAdminError && e.kind === 'not_found')) throw e;
}
