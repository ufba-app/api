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
import { CalendarModule } from './interface/calendar/calendar.module';
import { CalendarAlertService } from './application/calendar/calendar-alerts';
import { CalendarWatcher } from './application/calendar/calendar-watcher';
import { CalendarLogRepository, CalendarReader, CalendarSource, CalendarTextExtractor, CALENDAR_READER } from './application/ports/calendar';
import { AnthropicCalendarReader } from './infrastructure/sources/supac/anthropic-calendar-reader';
import { PdfParseCalendarText, SupacCalendarSource } from './infrastructure/sources/supac/supac-calendar-source';
import { PublishedCalendar } from './application/calendar/published-calendar';
import { webEnv } from './interface/web/web-auth';
import { MemoryAccess, MemoryAdmin, MemoryMcp, MemoryProjectRegistry, MemoryUserRepository } from './application/memory/memory-ports';
import { MemoryUsers } from './application/memory/memory-users';
import { LiveSources } from './application/ports/live-source';
import { mcpExports, mcpProviders } from './mcp-wiring';
import { SourceBindings } from './application/identity/source-bindings';
import { SiasbSource } from './application/ports/siasb-source';
import { SiasbLink } from './application/siasb/siasb-link';
import { SiasbReader } from './application/siasb/siasb-reader';
import { SiasbSyncer } from './application/siasb/siasb-syncer';
import { SiasbSyncProvider } from './application/siasb/siasb-sync-provider';
import { SYNC_PROVIDERS } from './application/jobs/sync-provider';
import { SiasbCopyReader } from './application/siasb/siasb-copy-reader';
import { SiasbCopyRepository } from './application/ports/siasb-copy';
import { AcademicCalendar } from './application/ports/academic-calendar';
import { PublishedAcademicCalendar } from './application/siasb/published-academic-calendar';
import { SiasbClient } from './infrastructure/sources/siasb/siasb-client';
import { SigaaSessionStore, SourceAccountRepository, StudentRegistrations } from './application/ports/repositories';
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
import { DriveDownloader } from './application/ports/drive-downloader';
import { DriveRefs } from './infrastructure/sources/drive/drive-refs';
import { DisabledDriveDownloader, GoogleDriveDownloader } from './infrastructure/sources/drive/google-drive-downloader';
import { MoodleGateway } from './infrastructure/sources/moodle/moodle.gateway';
import { MoodleLive } from './infrastructure/sources/moodle/moodle-live';
import { createSigaaHttpClient } from './infrastructure/sources/sigaa/http-client';
import { MemorySigaaSessionStore } from './infrastructure/sources/sigaa/memory-session-store';
import { SessoesSigaa } from './infrastructure/sources/sigaa/sessoes-sigaa';
import { SigaaSession } from './infrastructure/sources/sigaa/session';
import { SigaaGateway } from './infrastructure/sources/sigaa/sigaa-gateway';
import { SigaaPublicCatalogSource } from './infrastructure/sources/sigaa/catalog/sigaa-public-catalog';
import { CatalogService } from './application/academic/catalog.service';
import { AcademicImports } from './application/academic/academic-imports';
import { AcademicRepository, TranscriptSource } from './application/ports/academic';
import { PdfTextExtractor, TRANSCRIPT_READER, TranscriptReader } from './application/ports/transcript';
import { ConnectionStatus } from './application/web/connection-status';
import { AnthropicTranscriptReader } from './infrastructure/sources/sigaa/history/anthropic-transcript-reader';
import { SessionTranscriptSource } from './infrastructure/sources/sigaa/history/session-transcript-source';
import { PdfParseTextExtractor } from './infrastructure/sources/sigaa/history/pdf-text-extractor';
import { CatalogRepository, CatalogSource } from './application/ports/catalog';
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

/** Sessões do SIGAA por pessoa (cookie cifrado no store, trava entre instâncias), com o cliente HTTP real. */
export function buildSessoesSigaa(
  store: SigaaSessionStore = new MemorySigaaSessionStore(),
  cipher: SecretCipher = new AesSecretCipher(),
): SessoesSigaa {
  return new SessoesSigaa(() => new SigaaSession(createSigaaHttpClient()), store, cipher);
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
  // Sem SECRETS_KEY os `ref` do Drive não podem ser assinados: o recurso fica desligado.
  live.register(new MoodleLive(fetch, env.SECRETS_KEY ? new DriveRefs(env.SECRETS_KEY) : undefined));
  live.register(new SigaaLive(sessoesSigaa));
  const c = classroomClientes(env);
  if (c) live.register(new ClassroomLive(c, { dominio: env.GOOGLE_ALLOWED_DOMAIN || undefined }));
  return live;
}

// Global: o McpModule (interface) enxerga as portas ligadas aqui sem importar a infraestrutura.
@Global()
@Module({
  imports: [PersistenceModule, McpModule, WebModule, MemoryModule, CalendarModule],
  controllers: [HealthController, UsuariosController, FontesController, DownloadController],
  providers: [
    IdentityService,
    BearerGuard,
    ConsultaService,
    { provide: DownloadLinks, useFactory: () => new DownloadLinks() },
    {
      // Arquivos do Drive linkados no Moodle: token da pessoa (Classroom) e, sem acesso, link público; só hosts do Google.
      provide: DriveDownloader,
      useFactory: (): DriveDownloader => {
        const env = process.env;
        if (!env.SECRETS_KEY) return new DisabledDriveDownloader();
        // Sem Classroom configurado só vale o link público.
        return new GoogleDriveDownloader(new DriveRefs(env.SECRETS_KEY), classroomClientes(env) ?? {}, { dominio: env.GOOGLE_ALLOWED_DOMAIN || undefined });
      },
    },
    {
      provide: SessoesSigaa,
      useFactory: (store: SigaaSessionStore, cipher: SecretCipher) => buildSessoesSigaa(store, cipher),
      inject: [SigaaSessionStore, SecretCipher],
    },
    {
      provide: LiveSources,
      useFactory: (sessoes: SessoesSigaa) => buildLiveSources(process.env, sessoes),
      inject: [SessoesSigaa],
    },
    { provide: SecretCipher, useFactory: () => new AesSecretCipher() },
    // SIASB (clínicas): leitura ao vivo pelo cliente HTTP; conectar/desconectar pelo vínculo da matrícula.
    { provide: SiasbSource, useFactory: () => new SiasbClient() },
    {
      provide: SiasbLink,
      useFactory: (
        siasb: SiasbSource,
        regs: StudentRegistrations,
        bindings: SourceBindings,
        accounts: SourceAccountRepository,
        cipher: SecretCipher,
        copy: SiasbCopyRepository,
      ) => new SiasbLink(siasb, regs, bindings, accounts, cipher, copy),
      inject: [SiasbSource, StudentRegistrations, SourceBindings, SourceAccountRepository, SecretCipher, SiasbCopyRepository],
    },
    {
      provide: AcademicCalendar,
      useFactory: (logs: CalendarLogRepository) => new PublishedAcademicCalendar(logs),
      inject: [CalendarLogRepository],
    },
    {
      provide: SiasbReader,
      useFactory: (siasb: SiasbSource, accounts: SourceAccountRepository, cipher: SecretCipher, calendar: AcademicCalendar) =>
        new SiasbReader(siasb, accounts, cipher, calendar),
      inject: [SiasbSource, SourceAccountRepository, SecretCipher, AcademicCalendar],
    },
    {
      provide: SiasbSyncer,
      useFactory: (reader: SiasbReader, copy: SiasbCopyRepository, cipher: SecretCipher) =>
        new SiasbSyncer(reader, copy, cipher),
      inject: [SiasbReader, SiasbCopyRepository, SecretCipher],
    },
    {
      provide: SiasbSyncProvider,
      useFactory: (syncer: SiasbSyncer, copy: SiasbCopyRepository) => new SiasbSyncProvider(syncer, copy),
      inject: [SiasbSyncer, SiasbCopyRepository],
    },
    {
      // Fontes sincronizadas pelo cron genérico (src/sync-job.ts). Nova fonte = acrescentar o provedor aqui.
      provide: SYNC_PROVIDERS,
      useFactory: (siasb: SiasbSyncProvider) => [siasb],
      inject: [SiasbSyncProvider],
    },
    {
      provide: SiasbCopyReader,
      useFactory: (copy: SiasbCopyRepository, cipher: SecretCipher, calendar: AcademicCalendar) =>
        new SiasbCopyReader(copy, cipher, calendar),
      inject: [SiasbCopyRepository, SecretCipher, AcademicCalendar],
    },
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
      useFactory: (roles: TeamRoleRepository, projects: MemoryProjectRepository) => new DbTeamGrantSource(roles, projects),
      inject: [TeamRoleRepository, MemoryProjectRepository],
    },
    {
      provide: MemoryAdmins,
      useFactory: (directory: UserDirectory) => new MemoryAdmins(directory, MemoryAdmins.parse(process.env.ADMIN_EMAILS)),
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
    // Calendário acadêmico (SUPAC): leitura semanal pela IA + alertas para admin. Sem ANTHROPIC_API_KEY não lê nada.
    { provide: CALENDAR_READER, useFactory: () => (process.env.ANTHROPIC_API_KEY ? new AnthropicCalendarReader() : null) },
    { provide: CalendarSource, useFactory: () => new SupacCalendarSource() },
    { provide: CalendarTextExtractor, useFactory: () => new PdfParseCalendarText() },
    {
      provide: CalendarWatcher,
      useFactory: (logs: CalendarLogRepository, source: CalendarSource, extractor: CalendarTextExtractor, reader: CalendarReader | null) =>
        new CalendarWatcher(logs, source, extractor, reader),
      inject: [CalendarLogRepository, CalendarSource, CalendarTextExtractor, CALENDAR_READER],
    },
    {
      provide: CalendarAlertService,
      useFactory: (logs: CalendarLogRepository, admins: MemoryAdmins, watcher: CalendarWatcher) =>
        new CalendarAlertService(logs, admins, undefined, watcher.available() ? watcher : null),
      inject: [CalendarLogRepository, MemoryAdmins, CalendarWatcher],
    },
    { provide: PublishedCalendar, useFactory: (logs: CalendarLogRepository) => new PublishedCalendar(logs), inject: [CalendarLogRepository] },
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
    // Catálogo público do curso (currículo Ativo): importa só quando falta, sem login. Ainda não usado por rota; as
    // próximas fases ligam ao histórico do aluno (docs/specs/2026-11-15-vida-academica.md).
    { provide: CatalogSource, useFactory: () => new SigaaPublicCatalogSource() },
    {
      provide: CatalogService,
      useFactory: (repo: CatalogRepository, source: CatalogSource) => new CatalogService(repo, source),
      inject: [CatalogRepository, CatalogSource],
    },
    // Vida acadêmica: histórico lido pela IA (docs/specs/2026-11-15-vida-academica.md). Sem ANTHROPIC_API_KEY o leitor é
    // `null` e a importação não existe. O PDF vem de uma fonte que a fase 5 liga ao SIGAA (hoje "não ligada").
    { provide: PdfTextExtractor, useFactory: () => new PdfParseTextExtractor() },
    { provide: TranscriptSource, useFactory: (sessoes: SessoesSigaa) => new SessionTranscriptSource(sessoes), inject: [SessoesSigaa] },
    {
      provide: TRANSCRIPT_READER,
      useFactory: () => (process.env.ANTHROPIC_API_KEY ? new AnthropicTranscriptReader() : null),
    },
    {
      provide: AcademicImports,
      useFactory: (
        repo: AcademicRepository,
        source: TranscriptSource,
        extractor: PdfTextExtractor,
        reader: TranscriptReader | null,
        catalog: CatalogService,
        status: ConnectionStatus,
      ) =>
        new AcademicImports(repo, source, extractor, reader, catalog, status, undefined, {
          monthlyCapUsd: Number(process.env.ACADEMIC_MONTHLY_CAP_USD) > 0 ? Number(process.env.ACADEMIC_MONTHLY_CAP_USD) : 5,
        }),
      inject: [AcademicRepository, TranscriptSource, PdfTextExtractor, TRANSCRIPT_READER, CatalogService, ConnectionStatus],
    },
    ...mcpProviders,
  ],
  exports: [
    IdentityService,
    SourceRegistry,
    SecretCipher,
    SiasbSource,
    SiasbLink,
    SiasbReader,
    SiasbSyncer,
    SYNC_PROVIDERS,
    SiasbCopyReader,
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
    CalendarAlertService,
    PublishedCalendar,
    CalendarWatcher,
    AccountDeparture,
    DownloadLinks,
    LiveSources,
    AcademicImports,
    ...mcpExports,
  ],
})
export class AppModule {}
