import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { WebService } from './application/web/web.service';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';

async function bootstrap(): Promise<void> {
  // Intermediário que o AVA não envia (ver extra-ca.ts). Antes de qualquer conexão TLS.
  const cas = loadExtraCAs();
  if (cas.length) console.log(`[tls] CAs extras carregadas: ${cas.join(', ')}`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Atrás do proxy do Railway: IP e protocolo reais vêm dos headers X-Forwarded-*.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const webOrigin = process.env.WEB_ORIGIN?.replace(/\/+$/, '');
  if (webOrigin) {
    // Só o app web, com cookie. Nunca '*'. X-UFBA força preflight nas rotas que mudam estado (CSRF).
    app.enableCors({
      origin: webOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-UFBA', 'Authorization'],
      maxAge: 600,
    });
    await app.get(WebService).ensureWebClient();
    console.log(`[web] modo web ligado: ${webOrigin}`);
  }

  // Local por padrão: só 127.0.0.1. Em produção (Railway) defina HOST=0.0.0.0.
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
