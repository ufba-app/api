import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { WebService } from './application/web/web.service';
import { loadExtraCAs } from './infrastructure/tls/extra-ca';
import { webEnv } from './interface/web/web-auth';

async function bootstrap(): Promise<void> {
  // Intermediário que o AVA não envia (ver extra-ca.ts). Antes de qualquer conexão TLS.
  const cas = loadExtraCAs();
  if (cas.length) console.log(`[tls] CAs extras carregadas: ${cas.join(', ')}`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Atrás do proxy do Railway: IP e protocolo reais vêm dos headers X-Forwarded-*.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const webOrigin = process.env.WEB_ORIGIN?.replace(/\/+$/, '');
  if (webOrigin && !process.env.PUBLIC_URL) {
    // Sem PUBLIC_URL a URL de callback viria do header Host (forjável) e o cookie perderia Secure/__Host-.
    throw new Error('WEB_ORIGIN exige PUBLIC_URL (ex.: https://api.ufba.app)');
  }
  if (webOrigin) {
    // Só as origens da casa (painel e auth), com cookie. Nunca '*'. X-UFBA força preflight nas rotas que mudam estado.
    const { origins, authOrigin } = webEnv();
    app.enableCors({
      origin: origins,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-UFBA', 'Authorization'],
      maxAge: 600,
    });
    await app.get(WebService).ensureWebClient();
    console.log(`[web] modo web ligado: painel ${webOrigin}, auth ${authOrigin}`);
  }

  // Local por padrão: só 127.0.0.1. Em produção (Railway) defina HOST=0.0.0.0.
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
