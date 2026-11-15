import { USER_DIRECTORY, type UserDirectory } from './application/oauth/oauth-ports';
import { Global, Module } from '@nestjs/common';
import { IdentityService } from './application/identity/identity.service';
import { ConsultaService } from './application/live/consulta.service';
import { DownloadLinks } from './application/live/download-links';
import { DbProjectRegistry, OpenMemoryAccess } from './application/memory/memory-defaults';
import { GrantReconciler } from './application/memory/grant-reconciler';
import { AccountDeparture, MemoryDeparture } from './application/memory/memory-departure';
import { MemoryMaintenance } from './application/memory/memory-maintenance';
import { MemoryProjects } from './application/memory/memory-projects';
import { MemoryGrantSync, MemoryProjectRepository, MemorySyncJobRepository, TeamGrantSource } from './application/memory/project-ports';
import { DbTeamGrantSource, MemoryAdmins, TeamRoles } from './application/memory/team-roles';
import { TeamRoleRepository, UserLister } from './application/memory/team-ports';
import { ProxyKeyRotation, ProxyKeyStore, DEFAULT_MAX_AGE_DAYS } from './application/memory/proxy-key-rotation';
import { MemoryScheduler } from './infrastructure/memory/memory-scheduler';
import { MemoryProxy } from './application/memory/memory-proxy';
import { DeviceAuthorizations } from './application/memory/device-authorizations';
import { DeviceAuthorizationRepository, MemoryComputerDirectory, MemoryComputerRepository } from './application/memory/device-ports';
import { InstallManifests, ManifestSource } from './application/memory/install-manifest';
import { MemoryComputers } from './application/memory/memory-computers';
import { MemoryWeb } from './application/web/memory-web.service';
import { HttpManifestSource } from './infrastructure/memory/http-manifest-source';
import { MemoryModule } from './interface/memory/memory.module';
import { webEnv } from './interface/web/web-auth';
import { MemoryAccess, MemoryAdmin, MemoryMcp, MemoryProjectRegistry, MemoryUserRepository } from './application/memory/memory-ports';
import { MemoryUsers } from './application/memory/memory-users';
import { LiveSources } from './application/ports/live-source';
import { mcpExports, mcpProviders } from './mcp-wiring';
import { SecretCipher } from './application/ports/secret-cipher';
import { SourceGateway, SourceRegistry } from './application/ports/source-gateway';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from './infrastructure/memory/memory-admin.client';
import { MemoryMcpClient } from './infrastructure/memory/memory-mcp.client';
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
  imports: [PersistenceModule, McpModule, WebModule, MemoryModule],
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
      useFactory: (admin: MemoryAdmin, repo: MemoryUserRepository, cipher: SecretCipher, users: UserDirectory) =>
        new MemoryUsers(admin, repo, cipher, async (id) => (await users.findProfile(id))?.name ?? null),
      inject: [MemoryAdmin, MemoryUserRepository, SecretCipher, USER_DIRECTORY],
    },
    { provide: MemoryMcp, useFactory: () => MemoryMcpClient.fromEnv() },
    {
      provide: MemoryProjectRegistry,
      useFactory: (projects: MemoryProjectRepository) => new DbProjectRegistry(projects),
      inject: [MemoryProjectRepository],
    },
    // Papéis do time: configuração semeada por migração; a atribuição por pessoa é do admin.
    {
      provide: TeamGrantSource,
      useFactory: (roles: TeamRoleRepository) => new DbTeamGrantSource(roles),
      inject: [TeamRoleRepository],
    },
    {
      provide: MemoryAdmins,
      useFactory: (directory: UserDirectory) => new MemoryAdmins(directory, MemoryAdmins.parse(process.env.MEMORY_ADMIN_EMAILS)),
      inject: [USER_DIRECTORY],
    },
    {
      provide: TeamRoles,
      useFactory: (
        admins: MemoryAdmins,
        roles: TeamRoleRepository,
        lister: UserLister,
        projects: MemoryProjectRepository,
        jobs: MemorySyncJobRepository,
        reconciler: GrantReconciler,
        directory: UserDirectory,
      ) => new TeamRoles(admins, roles, lister, projects, jobs, reconciler, directory),
      inject: [MemoryAdmins, TeamRoleRepository, UserLister, MemoryProjectRepository, MemorySyncJobRepository, GrantReconciler, USER_DIRECTORY],
    },
    {
      provide: GrantReconciler,
      useFactory: (
        admin: MemoryAdmin,
        users: MemoryUsers,
        projects: MemoryProjectRepository,
        jobs: MemorySyncJobRepository,
        team: TeamGrantSource,
        directory: UserDirectory,
      ) =>
        new GrantReconciler({
          admin,
          users,
          projects,
          jobs,
          team,
          emailOf: async (id) => (await directory.findProfile(id))?.email ?? null,
        }),
      inject: [MemoryAdmin, MemoryUsers, MemoryProjectRepository, MemorySyncJobRepository, TeamGrantSource, USER_DIRECTORY],
    },
    { provide: MemoryGrantSync, useExisting: GrantReconciler },
    {
      provide: MemoryProjects,
      useFactory: (
        projects: MemoryProjectRepository,
        jobs: MemorySyncJobRepository,
        reconciler: GrantReconciler,
        admin: MemoryAdmin,
        users: MemoryUsers,
        directory: UserDirectory,
      ) =>
        new MemoryProjects({
          projects,
          jobs,
          reconciler,
          admin,
          users,
          directory,
          domain: (process.env.GOOGLE_ALLOWED_DOMAIN || 'ufba.br').toLowerCase(),
        }),
      inject: [MemoryProjectRepository, MemorySyncJobRepository, GrantReconciler, MemoryAdmin, MemoryUsers, USER_DIRECTORY],
    },
    {
      provide: MemoryDeparture,
      useFactory: (
        admin: MemoryAdmin,
        users: MemoryUsers,
        computers: MemoryComputers,
        projects: MemoryProjectRepository,
        service: MemoryProjects,
        reconciler: GrantReconciler,
      ) => new MemoryDeparture(admin, users, computers, projects, service, reconciler),
      inject: [MemoryAdmin, MemoryUsers, MemoryComputers, MemoryProjectRepository, MemoryProjects, GrantReconciler],
    },
    { provide: AccountDeparture, useExisting: MemoryDeparture },
    {
      provide: MemoryMaintenance,
      useFactory: (reconciler: GrantReconciler, computers: MemoryComputers, rotation: ProxyKeyRotation) => {
        const days = Number(process.env.MEMORY_PROXY_KEY_MAX_AGE_DAYS);
        return new MemoryMaintenance(reconciler, computers, rotation, Number.isFinite(days) && days >= 0 ? days : DEFAULT_MAX_AGE_DAYS);
      },
      inject: [GrantReconciler, MemoryComputers, ProxyKeyRotation],
    },
    {
      provide: ProxyKeyRotation,
      useFactory: (admin: MemoryAdmin, repo: MemoryUserRepository, store: ProxyKeyStore, cipher: SecretCipher) =>
        new ProxyKeyRotation(admin, repo, store, cipher),
      inject: [MemoryAdmin, MemoryUserRepository, ProxyKeyStore, SecretCipher],
    },
    MemoryScheduler,
    { provide: MemoryAccess, useFactory: () => new OpenMemoryAccess() },
    {
      provide: MemoryProxy,
      useFactory: (
        admin: MemoryAdmin,
        users: MemoryUsers,
        mcp: MemoryMcp,
        registry: MemoryProjectRegistry,
        access: MemoryAccess,
        computers: MemoryComputerDirectory,
        sync: MemoryGrantSync,
      ) => new MemoryProxy(admin, users, mcp, registry, access, computers, { sync, webOrigin: () => webEnv().webOrigin }),
      inject: [
        MemoryAdmin,
        MemoryUsers,
        MemoryMcp,
        MemoryProjectRegistry,
        MemoryAccess,
        MemoryComputerDirectory,
        MemoryGrantSync,
      ],
    },
    {
      provide: MemoryComputers,
      useFactory: (admin: MemoryAdmin, users: MemoryUsers, repo: MemoryComputerRepository) =>
        new MemoryComputers(admin, users, repo),
      inject: [MemoryAdmin, MemoryUsers, MemoryComputerRepository],
    },
    { provide: MemoryComputerDirectory, useExisting: MemoryComputers },
    {
      provide: DeviceAuthorizations,
      useFactory: (repo: DeviceAuthorizationRepository) =>
        new DeviceAuthorizations(repo, { webOrigin: () => webEnv().webOrigin }),
      inject: [DeviceAuthorizationRepository],
    },
    { provide: ManifestSource, useFactory: () => HttpManifestSource.fromEnv() },
    {
      provide: InstallManifests,
      useFactory: (source: ManifestSource) => new InstallManifests(source),
      inject: [ManifestSource],
    },
    {
      provide: MemoryWeb,
      useFactory: (
        device: DeviceAuthorizations,
        computers: MemoryComputers,
        users: MemoryUsers,
        admin: MemoryAdmin,
        projects: MemoryProjects,
        admins: MemoryAdmins,
      ) => new MemoryWeb(device, computers, users, admin, projects, admins),
      inject: [DeviceAuthorizations, MemoryComputers, MemoryUsers, MemoryAdmin, MemoryProjects, MemoryAdmins],
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
    MemoryProxy,
    MemoryComputers,
    DeviceAuthorizations,
    InstallManifests,
    MemoryWeb,
    MemoryProjects,
    GrantReconciler,
    TeamRoles,
    AccountDeparture,
    DownloadLinks,
    LiveSources,
    ...mcpExports,
  ],
})
export class AppModule {}
