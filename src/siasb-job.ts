import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SiasbSyncer } from './application/siasb/siasb-syncer';
import { runSiasbJob } from './application/siasb/siasb-job';
import { SiasbCopyRepository } from './application/ports/siasb-copy';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';

/**
 * Ponto de entrada do CRON do SIASB (serviço `siasb-cron` no Railway; ver docs/SIASB-CRON.md).
 * Sobe o contexto do Nest SEM HTTP, sincroniza quem está devido e termina: 0 se rodou, 1 se a execução falhou.
 */
async function main(): Promise<number> {
  // Execução avulsa: nada de varredura periódica da memória rodando dentro do cron.
  process.env.MEMORY_SCHEDULER = 'off';
  loadExtraCAs();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    return await runSiasbJob({
      syncer: app.get(SiasbSyncer),
      copy: app.get(SiasbCopyRepository),
    });
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log('siasb: não foi possível iniciar');
    process.exit(1);
  },
);
