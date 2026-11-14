import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MemoryMaintenance } from '../../application/memory/memory-maintenance';
import { MemoryAdmin } from '../../application/memory/memory-ports';

export const MAINTENANCE_EVERY_MS = 10 * 60_000;

/**
 * Roda a varredura da memória a cada 10 min (e uma vez logo depois do boot). Só liga quando o memory está configurado,
 * fora de testes e sem `MEMORY_SCHEDULER=off`. Loga só contagens, nunca nomes, e-mails ou corpo de resposta.
 */
@Injectable()
export class MemoryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MemoryScheduler');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly maintenance: MemoryMaintenance,
    private readonly admin: MemoryAdmin,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.MEMORY_SCHEDULER === 'off' || !this.admin.isConfigured()) return;
    const tick = () => void this.tick();
    this.first = setTimeout(tick, 30_000);
    this.timer = setInterval(tick, MAINTENANCE_EVERY_MS);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const r = await this.maintenance.run();
      this.log.log(
        `varredura: ${r.reconciled} reconciliadas, ${r.failed} falhas, ${r.retried} jobs retentados, ` +
          `${r.sweptComputers} chaves não confirmadas revogadas, ${r.unknownProjects} projetos desconhecidos`,
      );
    } catch {
      this.log.warn('varredura falhou');
    }
  }
}
