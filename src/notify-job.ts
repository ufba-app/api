import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ALERT_PROVIDERS, type AlertProvider } from './application/notifications/alert-provider';
import { runNotifyJob } from './application/notifications/notify-job';

/**
 * Ponto de entrada do CRON de avisos (serviço `notify-cron` no Railway, a cada 15 minutos; ver docs/NOTIFICACOES.md).
 * Sobe o contexto do Nest SEM HTTP, avalia cada `AlertProvider` registrado e termina: 0 se rodou, 1 se falhou.
 * Só lê o banco (nenhuma requisição às fontes) e envia pelo `Notifier`; precisa das variáveis VAPID.
 */
async function main(): Promise<number> {
  // Execução avulsa: nada de varredura periódica da memória rodando dentro do cron.
  process.env.MEMORY_SCHEDULER = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    return await runNotifyJob({ providers: app.get<AlertProvider[]>(ALERT_PROVIDERS) });
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log('notify: não foi possível iniciar');
    process.exit(1);
  },
);
