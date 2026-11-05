import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';

async function bootstrap(): Promise<void> {
  // Intermediário que o AVA não envia (ver extra-ca.ts). Antes de qualquer conexão TLS.
  const cas = loadExtraCAs();
  if (cas.length) console.log(`[tls] CAs extras carregadas: ${cas.join(', ')}`);

  const app = await NestFactory.create(AppModule);
  // Local por padrão: só 127.0.0.1. Em produção (Railway) defina HOST=0.0.0.0.
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
