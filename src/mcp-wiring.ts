import type { Provider } from '@nestjs/common';
import { IdentityService } from './application/identity/identity.service';
import { ConsultaService } from './application/live/consulta.service';
import { DownloadLinks } from './application/live/download-links';
import {
  CLASSROOM_LINK,
  CHAVE_DO_CLIENTE,
  GOOGLE_LINK,
  MOODLE_LINK,
  OAUTH_STORE,
  SIGAA_LINK,
  USER_DIRECTORY,
  type ChaveDoClientePort,
  type ClassroomLinkPort,
  type MoodleLinkPort,
  type OAuthStore,
  type SigaaLinkPort,
  type UserDirectory,
} from './application/oauth/oauth-ports';
import { ClientDirectory } from './application/oauth/client-directory';
import { AuthorizationRequests } from './application/web/authorization-requests.service';
import { AuthorizedApps } from './application/web/authorized-apps.service';
import { ConnectionStatus } from './application/web/connection-status';
import { PermissionsService } from './application/permissions/permissions.service';
import { ALERT_PROVIDERS, type AlertProvider } from './application/notifications/alert-provider';
import { NotificationSettings } from './application/notifications/notification-settings.service';
import { Notifier } from './application/notifications/notifier';
import { PushDevices } from './application/notifications/push-devices.service';
import { AlertLogRepository, NotificationSettingRepository, PushDeviceRepository, PushSender } from './application/ports/notifications';
import { SecretCipher } from './application/ports/secret-cipher';
import { WebPushSender } from './infrastructure/push/web-push-sender';
import { SigaaLaunch } from './application/web/sigaa-launch.service';
import { SigaaLoginFormSource } from './application/ports/sigaa-launch';
import { HttpSigaaLoginFormSource } from './infrastructure/sources/sigaa/login-form-source';
import { ClientPermissionRepository } from './application/ports/permissions';
import { ConnectionsService } from './application/web/connections.service';
import { SigaaPasskeys } from './application/web/sigaa-passkeys.service';
import { SigaaPairings } from './application/web/sigaa-pairings.service';
import { WebSessionService } from './application/web/web-session.service';
import { FileVerifiedApps, HttpsClientMetadataFetcher } from './infrastructure/oauth/client-metadata';
import { webEnv } from './interface/web/web-auth';
import { CLIENT_DIRECTORY } from './interface/web/web-tokens';
import { OAuthAccessTokenAuthenticator, OAuthService } from './application/oauth/oauth.service';
import { AUTHENTICATORS, type Authenticator } from './application/ports/authenticator';
import {
  SigaaCredentialRepository,
  SigaaMasterSlotRepository,
  SigaaPairingRepository,
  SigaaVaultRepository,
  SourceAccountRepository,
  SourceBindingRepository,
} from './application/ports/repositories';
import { SourceBindings } from './application/identity/source-bindings';
import { HmacSubjectHasher } from './infrastructure/crypto/hmac-subject-hasher';
import { CofreSigaa } from './application/sigaa/cofre-sigaa';
import { SiasbLink } from './application/siasb/siasb-link';
import { SiasbAlertProvider } from './application/siasb/siasb-alert-provider';
import { SiasbAlerts } from './application/siasb/siasb-alerts';
import { SiasbCopyRepository } from './application/ports/siasb-copy';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { ClassroomLink } from './infrastructure/sources/classroom/classroom-link';
import { GoogleOAuthLink } from './infrastructure/sources/google/google-oauth-link';
import { SigaaLink } from './infrastructure/sources/sigaa/sigaa-link';
import { MoodleLink } from './infrastructure/sources/moodle/moodle-link';
import { AuthenticatorsMcpAuth } from './interface/mcp/mcp-auth';
import { McpUseCasesImpl } from './interface/mcp/mcp-use-cases';
import { MCP_AUTH, MCP_CLINICA, MCP_MEMORY, MCP_USE_CASES } from './interface/mcp/mcp-ports';
import { McpClinicaImpl } from './interface/mcp/mcp-clinica';
import { SiasbCopyReader } from './application/siasb/siasb-copy-reader';
import { SiasbReader } from './application/siasb/siasb-reader';
import { SiasbSyncer } from './application/siasb/siasb-syncer';
import { MemoryProxy } from './application/memory/memory-proxy';
import { AccountDeparture } from './application/memory/memory-departure';
import { OAUTH_SERVICE } from './interface/mcp/oauth/oauth.controller';

/** Token do autenticador de access token OAuth (entra em AUTHENTICATORS junto da chave de API). */
export const OAUTH_ACCESS_AUTHENTICATOR = Symbol('OAUTH_ACCESS_AUTHENTICATOR');

/**
 * Raiz de composição do MCP e do OAuth do serviço: liga as portas às implementações reais. Fica na raiz de `src`
 * porque só ela pode enxergar `interface` e `infrastructure` ao mesmo tempo.
 */
export const mcpProviders: Provider[] = [
  // Ferramentas MCP: leitura ao vivo nas fontes + links de download.
  {
    provide: MCP_USE_CASES,
    useFactory: (consulta: ConsultaService, downloads: DownloadLinks) => new McpUseCasesImpl(consulta, downloads),
    inject: [ConsultaService, DownloadLinks],
  },

  // Clientes OAuth: registro dinâmico (banco) e documento de metadados (client_id = URL https), com a lista de
  // apps verificados de config/verified-apps.json.
  {
    provide: CLIENT_DIRECTORY,
    useFactory: (store: OAuthStore) =>
      new ClientDirectory(store, new HttpsClientMetadataFetcher(), new FileVerifiedApps(), () => webEnv().publicUrl),
    inject: [OAUTH_STORE],
  },
  // OAuth 2.1 do serviço (store e usuários persistentes vêm do PersistenceModule).
  {
    provide: OAUTH_SERVICE,
    useFactory: (store: OAuthStore, users: UserDirectory, chaves: ChaveDoClientePort, clients: ClientDirectory) =>
      new OAuthService(store, users, Date.now, chaves, clients),
    inject: [OAUTH_STORE, USER_DIRECTORY, CHAVE_DO_CLIENTE, CLIENT_DIRECTORY],
  },
  // API do app web: um caso de uso por responsabilidade (sessão, conexões, autorização, apps autorizados).
  {
    provide: ConnectionStatus,
    useFactory: (
      cofre: CofreSigaa,
      accounts: SourceAccountRepository,
      classroom: ClassroomLinkPort,
      slots: SigaaMasterSlotRepository,
      siasb: SiasbLink,
    ) => new ConnectionStatus(cofre, accounts, classroom, slots, siasb),
    inject: [CofreSigaa, SourceAccountRepository, CLASSROOM_LINK, SigaaMasterSlotRepository, SiasbLink],
  },
  {
    provide: SigaaPairings,
    useFactory: (repo: SigaaPairingRepository) => new SigaaPairings(repo),
    inject: [SigaaPairingRepository],
  },
  {
    provide: SigaaPasskeys,
    useFactory: (slots: SigaaMasterSlotRepository, status: ConnectionStatus) => new SigaaPasskeys(slots, status),
    inject: [SigaaMasterSlotRepository, ConnectionStatus],
  },
  {
    provide: WebSessionService,
    useFactory: (
      oauth: OAuthService,
      store: OAuthStore,
      users: UserDirectory,
      cofre: CofreSigaa,
      status: ConnectionStatus,
      departure: AccountDeparture,
    ) => new WebSessionService(oauth, store, users, cofre, status, webEnv().authOrigin, Date.now, departure),
    inject: [OAUTH_SERVICE, OAUTH_STORE, USER_DIRECTORY, CofreSigaa, ConnectionStatus, AccountDeparture],
  },
  {
    provide: ConnectionsService,
    useFactory: (
      users: UserDirectory,
      cofre: CofreSigaa,
      sigaa: SigaaLinkPort,
      moodle: MoodleLinkPort,
      classroom: ClassroomLinkPort,
      accounts: SourceAccountRepository,
      identity: IdentityService,
      bindings: SourceBindings,
      slots: SigaaMasterSlotRepository,
      siasb: SiasbLink,
      permissions: PermissionsService,
      syncer: SiasbSyncer,
    ) =>
      new ConnectionsService(
        users,
        cofre,
        sigaa,
        moodle,
        classroom,
        accounts,
        identity,
        bindings,
        slots,
        siasb,
        { webOrigin: webEnv().webOrigin, institutionalDomain: process.env.GOOGLE_ALLOWED_DOMAIN || 'ufba.br' },
        Date.now,
        (userId, source) => permissions.sourceDisconnected(userId, source),
        async (userId) => void (await syncer.syncUser(userId)),
        (userId) => syncer.syncUser(userId),
      ),
    inject: [
      USER_DIRECTORY,
      CofreSigaa,
      SIGAA_LINK,
      MOODLE_LINK,
      CLASSROOM_LINK,
      SourceAccountRepository,
      IdentityService,
      SourceBindings,
      SigaaMasterSlotRepository,
      SiasbLink,
      PermissionsService,
      SiasbSyncer,
    ],
  },
  {
    provide: SigaaLaunch,
    useFactory: (status: ConnectionStatus, form: SigaaLoginFormSource) => new SigaaLaunch(status, form),
    inject: [ConnectionStatus, SigaaLoginFormSource],
  },
  { provide: SigaaLoginFormSource, useFactory: () => new HttpSigaaLoginFormSource() },
  {
    provide: PermissionsService,
    useFactory: (repo: ClientPermissionRepository, status: ConnectionStatus) => new PermissionsService(repo, status),
    inject: [ClientPermissionRepository, ConnectionStatus],
  },
  // Canal de notificações (Web Push). VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT por ambiente; sem elas o canal fica desligado.
  { provide: PushSender, useFactory: () => new WebPushSender() },
  {
    provide: PushDevices,
    useFactory: (repo: PushDeviceRepository, sender: PushSender, cipher: SecretCipher) => new PushDevices(repo, sender, cipher),
    inject: [PushDeviceRepository, PushSender, SecretCipher],
  },
  {
    provide: NotificationSettings,
    // `status` filtra por acesso: quem não tem SIASB não vê os avisos dele.
    useFactory: (repo: NotificationSettingRepository, status: ConnectionStatus) => new NotificationSettings(repo, undefined, status),
    inject: [NotificationSettingRepository, ConnectionStatus],
  },
  {
    provide: Notifier,
    useFactory: (sender: PushSender, settings: NotificationSettings, devices: PushDevices, log: AlertLogRepository) =>
      new Notifier(sender, settings, devices, log),
    inject: [PushSender, NotificationSettings, PushDevices, AlertLogRepository],
  },
  // Fontes de avisos do `notify-cron`: cada fonte entra aqui (injete o que ela precisa e devolva o `AlertProvider`).
  {
    provide: SiasbAlerts,
    useFactory: (reader: SiasbCopyReader, copy: SiasbCopyRepository, notifier: Notifier, accounts: SourceAccountRepository) =>
      new SiasbAlerts(reader, copy, notifier, accounts),
    inject: [SiasbCopyReader, SiasbCopyRepository, Notifier, SourceAccountRepository],
  },
  {
    provide: SiasbAlertProvider,
    useFactory: (copy: SiasbCopyRepository, alerts: SiasbAlerts) => new SiasbAlertProvider(copy, alerts),
    inject: [SiasbCopyRepository, SiasbAlerts],
  },
  { provide: ALERT_PROVIDERS, useFactory: (siasb: SiasbAlertProvider): AlertProvider[] => [siasb], inject: [SiasbAlertProvider] },
  {
    provide: AuthorizationRequests,
    useFactory: (oauth: OAuthService, clients: ClientDirectory, cofre: CofreSigaa, status: ConnectionStatus, permissions: PermissionsService) =>
      new AuthorizationRequests(oauth, clients, cofre, status, permissions),
    inject: [OAUTH_SERVICE, CLIENT_DIRECTORY, CofreSigaa, ConnectionStatus, PermissionsService],
  },
  {
    provide: AuthorizedApps,
    useFactory: (store: OAuthStore, clients: ClientDirectory, cofre: CofreSigaa, permissions: PermissionsService) =>
      new AuthorizedApps(store, clients, cofre, permissions),
    inject: [OAUTH_STORE, CLIENT_DIRECTORY, CofreSigaa, PermissionsService],
  },
  // Vínculo fixo conta ↔ titular na fonte (CPF no SIGAA, usuário do AVA no Moodle).
  {
    provide: SourceBindings,
    useFactory: (repo: SourceBindingRepository) => new SourceBindings(repo, new HmacSubjectHasher()),
    inject: [SourceBindingRepository],
  },
  // Uma única instância do cofre (o mapa de pendentes é em memória): CHAVE_DO_CLIENTE e SIGAA_LINK a reutilizam.
  {
    provide: CofreSigaa,
    useFactory: (repo: SigaaCredentialRepository, vaults: SigaaVaultRepository) =>
      new CofreSigaa(repo, vaults, (k) => new AesSecretCipher(k.toString('base64'))),
    inject: [SigaaCredentialRepository, SigaaVaultRepository],
  },
  { provide: CHAVE_DO_CLIENTE, useExisting: CofreSigaa },
  { provide: SIGAA_LINK, useFactory: () => new SigaaLink() },
  {
    provide: OAUTH_ACCESS_AUTHENTICATOR,
    useFactory: (oauth: OAuthService) => new OAuthAccessTokenAuthenticator(oauth),
    inject: [OAUTH_SERVICE],
  },
  { provide: GOOGLE_LINK, useFactory: () => new GoogleOAuthLink() },
  {
    provide: CLASSROOM_LINK,
    useFactory: (identity: IdentityService, accounts: SourceAccountRepository) => new ClassroomLink(identity, accounts),
    inject: [IdentityService, SourceAccountRepository],
  },
  { provide: MOODLE_LINK, useFactory: () => new MoodleLink() },

  // Bearer: chave de API (`plt_`) e token OAuth, nesta ordem. REST e MCP usam a mesma lista.
  {
    provide: AUTHENTICATORS,
    useFactory: (identity: IdentityService, oauth: Authenticator): Authenticator[] => [
      identity,
      oauth,
    ],
    inject: [IdentityService, OAUTH_ACCESS_AUTHENTICATOR],
  },
  // Proxy de memória (memory_*): sem MEMORY_ROOT_TOKEN, `enabled()` é falso e o /mcp só tem as ferramentas da casa.
  { provide: MCP_MEMORY, useExisting: MemoryProxy },
  // Ferramentas clinica_*: só aparecem para quem tem conexão SIASB (decidido por requisição no controller).
  {
    provide: MCP_CLINICA,
    useFactory: (reader: SiasbReader, link: SiasbLink, copyReader: SiasbCopyReader) =>
      new McpClinicaImpl(reader, link, copyReader),
    inject: [SiasbReader, SiasbLink, SiasbCopyReader],
  },
  {
    provide: MCP_AUTH,
    useFactory: (authenticators: Authenticator[], permissions: PermissionsService) =>
      new AuthenticatorsMcpAuth(authenticators, permissions),
    inject: [AUTHENTICATORS, PermissionsService],
  },
];

/** O que o módulo global exporta para o `McpModule` e o `BearerGuard`. */
export const mcpExports = [
  PermissionsService,
  PushDevices,
  NotificationSettings,
  Notifier,
  ALERT_PROVIDERS,
  SigaaLaunch,
  WebSessionService,
  ConnectionsService,
  SigaaPasskeys,
  SigaaPairings,
  AuthorizationRequests,
  AuthorizedApps,
  CLIENT_DIRECTORY,
  MCP_USE_CASES,
  MCP_AUTH,
  MCP_MEMORY,
  MCP_CLINICA,
  OAUTH_SERVICE,
  GOOGLE_LINK,
  MOODLE_LINK,
  CLASSROOM_LINK,
  SIGAA_LINK,
  AUTHENTICATORS,
];
