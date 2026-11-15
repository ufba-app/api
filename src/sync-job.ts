import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SYNC_PROVIDERS, type SyncProvider } from './application/jobs/sync-provider';
import { runSyncJob } from './application/jobs/sync-runner';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';

/**
 * Ponto de entrada do CRON genérico de sincronização (serviço `sync-cron` no Railway; ver docs/SYNC-CRON.md).
 * Sobe o contexto do Nest SEM HTTP, sincroniza quem está devido em cada provedor e termina:
 * 0 se rodou, 1 se a listagem falhou para todos os provedores ou o contexto não subiu.
 */
async function main(): Promise<number> {
  // Execução avulsa: nada de varredura periódica da memória rodando dentro do cron.
  process.env.MEMORY_SCHEDULER = 'off';
  loadExtraCAs();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    return await runSyncJob({ providers: app.get<SyncProvider[]>(SYNC_PROVIDERS) });
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log('sync: não foi possível iniciar');
    process.exit(1);
  },
);
