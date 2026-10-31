import { Global, Module } from '@nestjs/common';
import { IdentityService } from './application/identity/identity.service';
import { mcpExports, mcpProviders } from './mcp-wiring';
import { HistoricoController } from './interface/rest/historico.controller';
import { SecretCipher } from './application/ports/secret-cipher';
import {
  SourceGateway,
  SourceRegistry,
} from './application/ports/source-gateway';
import { LeituraService } from './application/read/leitura.service';
import { SincronizarService } from './application/sync/sincronizar.service';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { BearerGuard } from './interface/rest/auth.guard';
import { HealthController } from './interface/rest/health.controller';
import { LeituraController } from './interface/rest/leitura.controller';
import { SincronizarController } from './interface/rest/sincronizar.controller';
import { UsuariosController } from './interface/rest/usuarios.controller';
import { CalendarGateway } from './infrastructure/sources/calendar/calendar.gateway';
import { ClassroomGateway } from './infrastructure/sources/classroom/classroom.gateway';
import { GoogleAuth, GoogleHttp } from './infrastructure/sources/google/google-http';
import { MoodleGateway } from './infrastructure/sources/moodle/moodle.gateway';
import { SigaaGateway } from './infrastructure/sources/sigaa/sigaa-gateway';
import { McpModule } from './interface/mcp/mcp.module';

/**
 * Fontes registradas. O Google só entra se GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET estiverem definidos.
 */
export function buildGateways(env: NodeJS.ProcessEnv = process.env): SourceGateway[] {
  const gateways: SourceGateway[] = [new SigaaGateway(), new MoodleGateway()];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const http = new GoogleHttp(GoogleAuth.fromEnv(env));
    gateways.push(new ClassroomGateway(http), new CalendarGateway(http));
  }
  return gateways;
}

// Global: o McpModule (interface) enxerga as portas ligadas aqui sem importar a infraestrutura.
@Global()
@Module({
  imports: [PersistenceModule, McpModule],
  controllers: [
    HealthController,
    HistoricoController,
    UsuariosController,
    SincronizarController,
    LeituraController,
  ],
  providers: [
    IdentityService,
    SincronizarService,
    LeituraService,
    BearerGuard,
    { provide: SecretCipher, useFactory: () => new AesSecretCipher() },
    {
      provide: SourceRegistry,
      useFactory: () => {
        const registry = new SourceRegistry();
        buildGateways().forEach((g) => registry.register(g));
        return registry;
      },
    },
    // MCP + OAuth do serviço, AUTHENTICATORS (chave de API + token OAuth), histórico e anexos: ver mcp-wiring.ts.
    ...mcpProviders,
  ],
  exports: [
    IdentityService,
    SourceRegistry,
    LeituraService,
    SincronizarService,
    SecretCipher,
    ...mcpExports,
  ],
})
export class AppModule {}
