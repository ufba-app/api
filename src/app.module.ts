import { Global, Module } from '@nestjs/common';
import { IdentityService } from './application/identity/identity.service';
import { ConsultaService } from './application/live/consulta.service';
import { DownloadLinks } from './application/live/download-links';
import { MemoryAdmin, MemoryUserRepository } from './application/memory/memory-ports';
import { MemoryUsers } from './application/memory/memory-users';
import { LiveSources } from './application/ports/live-source';
import { mcpExports, mcpProviders } from './mcp-wiring';
import { SecretCipher } from './application/ports/secret-cipher';
import { SourceGateway, SourceRegistry } from './application/ports/source-gateway';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from './infrastructure/memory/memory-admin.client';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { BearerGuard } from './interface/rest/auth.guard';
import { DownloadController } from './interface/rest/download.controller';
import { FontesController } from './interface/rest/fontes.controller';
import { HealthController } from './interface/rest/health.controller';
import { UsuariosController } from './interface/rest/usuarios.controller';
import { ClassroomGateway } from './infrastructure/sources/classroom/classroom.gateway';
import { ClassroomLive } from './infrastructure/sources/classroom/classroom-live';
import { GoogleAuth, GoogleHttp } from './infrastructure/sources/google/google-http';
import { MoodleGateway } from './infrastructure/sources/moodle/moodle.gateway';
import { MoodleLive } from './infrastructure/sources/moodle/moodle-live';
import { createSigaaHttpClient } from './infrastructure/sources/sigaa/http-client';
import { SessoesSigaa } from './infrastructure/sources/sigaa/sessoes-sigaa';
import { SigaaSession } from './infrastructure/sources/sigaa/session';
import { SigaaGateway } from './infrastructure/sources/sigaa/sigaa-gateway';
import { SigaaLive } from './infrastructure/sources/sigaa/sigaa-live';
import { McpModule } from './interface/mcp/mcp.module';
import { WebModule } from './interface/web/web.module';

function googleHttp(clientId?: string, clientSecret?: string): GoogleHttp | undefined {
  return clientId && clientSecret ? new GoogleHttp(new GoogleAuth({ clientId, clientSecret })) : undefined;
}

/**
 * Clientes HTTP do Classroom, um por app OAuth (o refresh token só renova com o app que o emitiu):
 * `ufba` = app interno do login (`GOOGLE_CLIENT_ID/SECRET`); `convidado` = app externo em teste
 * (`GOOGLE_CLASSROOM_CLIENT_ID/SECRET`).
 */
function classroomClientes(env: NodeJS.ProcessEnv): { ufba?: GoogleHttp; convidado?: GoogleHttp } | null {
  const ufba = googleHttp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const convidado = googleHttp(env.GOOGLE_CLASSROOM_CLIENT_ID, env.GOOGLE_CLASSROOM_CLIENT_SECRET);
  return ufba || convidado ? { ufba, convidado } : null;
}

/** Fontes registradas. O Classroom só entra se algum app OAuth estiver configurado. */
export function buildGateways(env: NodeJS.ProcessEnv = process.env): SourceGateway[] {
  const gateways: SourceGateway[] = [new SigaaGateway(), new MoodleGateway()];
  const c = classroomClientes(env);
  const http = c?.ufba ?? c?.convidado;
  if (http) gateways.push(new ClassroomGateway(http));
  return gateways;
}

/** Sessões do SIGAA em memória (uma por pessoa+cliente), cada uma com o cliente HTTP real. */
export function buildSessoesSigaa(): SessoesSigaa {
  return new SessoesSigaa(() => new SigaaSession(createSigaaHttpClient()));
}

/**
 * Fontes com leitura ao vivo: Moodle, SIGAA (a senha é aberta a cada consulta com a chave do token; ver
 * `ConsultaService`) e, se configurado, Classroom.
 */
export function buildLiveSources(
  env: NodeJS.ProcessEnv = process.env,
  sessoesSigaa: SessoesSigaa = buildSessoesSigaa(),
): LiveSources {
  const live = new LiveSources();
  live.register(new MoodleLive());
  live.register(new SigaaLive(sessoesSigaa));
  const c = classroomClientes(env);
  if (c) live.register(new ClassroomLive(c, { dominio: env.GOOGLE_ALLOWED_DOMAIN || undefined }));
  return live;
}

// Global: o McpModule (interface) enxerga as portas ligadas aqui sem importar a infraestrutura.
@Global()
@Module({
  imports: [PersistenceModule, McpModule, WebModule],
  controllers: [HealthController, UsuariosController, FontesController, DownloadController],
  providers: [
    IdentityService,
    BearerGuard,
    ConsultaService,
    { provide: DownloadLinks, useFactory: () => new DownloadLinks() },
    { provide: SessoesSigaa, useFactory: buildSessoesSigaa },
    {
      provide: LiveSources,
      useFactory: (sessoes: SessoesSigaa) => buildLiveSources(process.env, sessoes),
      inject: [SessoesSigaa],
    },
    { provide: SecretCipher, useFactory: () => new AesSecretCipher() },
    // Memória compartilhada: sem MEMORY_ROOT_TOKEN o cliente fica "não configurado" e nada de memory_* aparece.
    { provide: MemoryAdmin, useFactory: () => MemoryAdminClient.fromEnv() },
    {
      provide: MemoryUsers,
      useFactory: (admin: MemoryAdmin, repo: MemoryUserRepository, cipher: SecretCipher) =>
        new MemoryUsers(admin, repo, cipher),
      inject: [MemoryAdmin, MemoryUserRepository, SecretCipher],
    },
    {
      provide: SourceRegistry,
      useFactory: () => {
        const registry = new SourceRegistry();
        buildGateways().forEach((g) => registry.register(g));
        return registry;
      },
    },
    // MCP + OAuth do serviço, CofreSigaa (o ConsultaService depende dele) e AUTHENTICATORS: ver mcp-wiring.ts.
    ...mcpProviders,
  ],
  exports: [
    IdentityService,
    SourceRegistry,
    SecretCipher,
    ConsultaService,
    MemoryAdmin,
    MemoryUsers,
    DownloadLinks,
    LiveSources,
    ...mcpExports,
  ],
})
export class AppModule {}
