import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CalendarWatcher } from '../../application/calendar/calendar-watcher';

export const CALENDAR_EVERY_MS = 7 * 24 * 60 * 60_000;
/** Primeira leitura logo depois do boot: sem arquivo novo é só uma requisição à página, e um deploy não gera chamada à IA. */
const FIRST_RUN_MS = 2 * 60_000;

/**
 * Leitura semanal do calendário, o ano todo (não reagenda pela data de fim do semestre: a SUPAC reedita o mesmo semestre).
 * Só liga com a leitura configurada (`ANTHROPIC_API_KEY`), fora de testes e sem `CALENDAR_SCHEDULER=off`. Loga só contagens.
 */
@Injectable()
export class CalendarScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CalendarScheduler');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(private readonly watcher: CalendarWatcher) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.CALENDAR_SCHEDULER === 'off' || !this.watcher.available()) return;
    const tick = () => void this.tick();
    this.first = setTimeout(tick, FIRST_RUN_MS);
    this.timer = setInterval(tick, CALENDAR_EVERY_MS);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const r = await this.watcher.run();
      if (!r.ran) return;
      this.log.log(
        `calendário: ${r.considered} considerados, ${r.published} publicados, ${r.notVerified} não verificados, ${r.errors} erros, ${r.skipped} sem novidade`,
      );
      if (r.notVerified + r.errors > 0) this.log.warn('alerta: calendário com leitura a conferir (painel dos admins)');
    } catch {
      this.log.warn('leitura do calendário falhou');
    }
  }
}
