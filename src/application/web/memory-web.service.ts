import { DeviceAuthorizations } from '../memory/device-authorizations';
import { ComputerView, MemoryComputers } from '../memory/memory-computers';
import { MemoryAdmin } from '../memory/memory-ports';
import { MemoryProjects } from '../memory/memory-projects';
import { MemoryUsers } from '../memory/memory-users';
import type { MemoryAdmins } from '../memory/team-roles';
import type { WebPrincipal } from './web-api';

export interface MemoryStatusView {
  memoryAvailable: boolean;
  userReady: boolean;
  isAdmin: boolean;
  computers: ComputerView[];
}

/** Casos de uso do app web para a memória (dispositivo, computadores, estado). Sem regra: delega aos serviços. */
export class MemoryWeb {
  constructor(
    private readonly device: DeviceAuthorizations,
    private readonly computers: MemoryComputers,
    private readonly users: MemoryUsers,
    private readonly admin: MemoryAdmin,
    private readonly projects: MemoryProjects,
    private readonly admins: MemoryAdmins,
  ) {}

  lookup(p: WebPrincipal, ip: string | null, userCode: string) {
    return this.device.lookup(p.userId, ip, userCode);
  }

  decide(p: WebPrincipal, ip: string | null, userCode: string, decision: 'approve' | 'deny') {
    return this.device.decide(p.userId, ip, userCode, decision);
  }

  async status(p: WebPrincipal): Promise<MemoryStatusView> {
    const memoryAvailable = this.admin.isConfigured();
    return {
      memoryAvailable,
      userReady: memoryAvailable && (await this.users.isReady(p.userId)),
      isAdmin: await this.isAdmin(p.userId),
      computers: memoryAvailable ? await this.computers.list(p.userId) : [],
    };
  }

  isAdmin(userId: string): Promise<boolean> {
    return this.admins.isAdmin(userId);
  }

  listProjects(p: WebPrincipal) {
    return this.projects.list(p.userId);
  }

  createProject(p: WebPrincipal, name: string) {
    return this.projects.create(p.userId, name);
  }

  projectDetail(p: WebPrincipal, id: string) {
    return this.projects.detail(p.userId, id);
  }

  setMember(p: WebPrincipal, id: string, email: string, level: 'read' | 'write') {
    return this.projects.setMember(p.userId, id, email, level);
  }

  removeMember(p: WebPrincipal, id: string, email: string) {
    return this.projects.removeMember(p.userId, id, email);
  }

  transferProject(p: WebPrincipal, id: string, email: string) {
    return this.projects.transfer(p.userId, id, email);
  }

  deleteProject(p: WebPrincipal, id: string) {
    return this.projects.remove(p.userId, id);
  }

  list(p: WebPrincipal) {
    return this.computers.list(p.userId);
  }

  rename(p: WebPrincipal, id: string, name: string) {
    return this.computers.rename(p.userId, id, name);
  }

  revoke(p: WebPrincipal, id: string) {
    return this.computers.revoke(p.userId, id);
  }
}
