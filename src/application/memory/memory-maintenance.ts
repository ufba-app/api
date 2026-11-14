import { GrantReconciler } from './grant-reconciler';
import { MemoryComputers } from './memory-computers';
import { ProxyKeyRotation } from './proxy-key-rotation';

export interface MaintenanceReport {
  sweptComputers: number;
  retried: number;
  reconciled: number;
  failed: number;
  unknownProjects: number;
  rotatedKeys: number;
}

const MAX_USERS_PER_RUN = 500;

/**
 * Varredura periódica (a cada 10 min, ver `MemoryScheduler`): garante os projetos do time no memory, revoga chaves de
 * computador nunca confirmadas, retenta jobs vencidos e reconcilia as pessoas com acesso dado por projeto ou papel.
 * Tudo idempotente; falha de uma pessoa não derruba as outras.
 */
export class MemoryMaintenance {
  private running = false;

  constructor(
    private readonly reconciler: GrantReconciler,
    private readonly computers: MemoryComputers,
    private readonly rotation?: ProxyKeyRotation,
    /** Idade máxima da chave de repasse, em dias (0 = gira todas, para incidente). */
    private readonly keyMaxAgeDays?: number,
  ) {}

  async run(): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { sweptComputers: 0, retried: 0, reconciled: 0, failed: 0, unknownProjects: 0, rotatedKeys: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      await this.reconciler.ensureTeamProjects().catch(() => undefined);
      report.sweptComputers = await this.computers.sweep().catch(() => 0);
      report.retried = await this.reconciler.runDue().catch(() => 0);
      for (const id of (await this.reconciler.involvedUserIds()).slice(0, MAX_USERS_PER_RUN)) {
        if (await this.reconciler.syncUser(id)) report.reconciled++;
        else report.failed++;
      }
      report.rotatedKeys = (await this.rotation?.rotateStale(this.keyMaxAgeDays).catch(() => 0)) ?? 0;
      report.unknownProjects = (await this.reconciler.unknownProjects().catch(() => [])).length;
      return report;
    } finally {
      this.running = false;
    }
  }
}
