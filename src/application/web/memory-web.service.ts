import { DeviceAuthorizations } from '../memory/device-authorizations';
import { ComputerView, MemoryComputers } from '../memory/memory-computers';
import { MemoryAdmin } from '../memory/memory-ports';
import { MemoryUsers } from '../memory/memory-users';
import type { UserDirectory } from '../oauth/oauth-ports';
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
    private readonly directory: UserDirectory,
    /** E-mails de administradores (`MEMORY_ADMIN_EMAILS`), já em minúsculas. */
    private readonly adminEmails: ReadonlySet<string>,
  ) {}

  static parseAdminEmails(raw: string | undefined): Set<string> {
    return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  }

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

  async isAdmin(userId: string): Promise<boolean> {
    if (this.adminEmails.size === 0) return false;
    const email = (await this.directory.findProfile(userId))?.email;
    return Boolean(email && this.adminEmails.has(email.toLowerCase()));
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
