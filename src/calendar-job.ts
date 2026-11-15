import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { runCalendarJob } from './application/calendar/calendar-job';
import { CalendarWatcher } from './application/calendar/calendar-watcher';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';

/**
 * Ponto de entrada do CRON do calendário (serviço próprio no Railway; ver docs/CALENDARIO-CRON.md).
 * Sobe o contexto do Nest SEM HTTP, roda `CalendarWatcher.run()` uma vez e termina: 0 se rodou, 1 se a execução falhou.
 */
async function main(): Promise<number> {
  // Esta é uma execução avulsa: nada de varredura periódica da memória rodando dentro do cron.
  process.env.MEMORY_SCHEDULER = 'off';
  loadExtraCAs();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    return await runCalendarJob(app.get(CalendarWatcher));
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log('calendário: não foi possível iniciar');
    process.exit(1);
  },
);
