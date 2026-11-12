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
import { WebService } from './application/web/web.service';
import { FileVerifiedApps, HttpsClientMetadataFetcher } from './infrastructure/oauth/client-metadata';
import { webEnv } from './interface/web/web-auth';
import { CLIENT_DIRECTORY } from './interface/web/web-tokens';
import { OAuthAccessTokenAuthenticator, OAuthService } from './application/oauth/oauth.service';
import { AUTHENTICATORS, type Authenticator } from './application/ports/authenticator';
import { SigaaCredentialRepository, SourceAccountRepository } from './application/ports/repositories';
import { CofreSigaa } from './application/sigaa/cofre-sigaa';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { ClassroomLink } from './infrastructure/sources/classroom/classroom-link';
import { GoogleOAuthLink } from './infrastructure/sources/google/google-oauth-link';
import { SigaaLink } from './infrastructure/sources/sigaa/sigaa-link';
import { MoodleLink } from './infrastructure/sources/moodle/moodle-link';
import { AuthenticatorsMcpAuth } from './interface/mcp/mcp-auth';
import { McpUseCasesImpl } from './interface/mcp/mcp-use-cases';
import { MCP_AUTH, MCP_USE_CASES } from './interface/mcp/mcp-ports';
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
  // API do app web (sessão, conexões, autorização, apps autorizados). WEB_ORIGIN liga o redirecionamento de /authorize.
  {
    provide: WebService,
    useFactory: (
      oauth: OAuthService,
      store: OAuthStore,
      users: UserDirectory,
      clients: ClientDirectory,
      cofre: CofreSigaa,
      sigaa: SigaaLinkPort,
      moodle: MoodleLinkPort,
      classroom: ClassroomLinkPort,
      accounts: SourceAccountRepository,
    ) =>
      new WebService(oauth, store, users, clients, cofre, sigaa, moodle, classroom, accounts, {
        webOrigin: webEnv().webOrigin || 'http://localhost:3001',
        authOrigin: webEnv().authOrigin || undefined,
      }),
    inject: [
      OAUTH_SERVICE,
      OAUTH_STORE,
      USER_DIRECTORY,
      CLIENT_DIRECTORY,
      CofreSigaa,
      SIGAA_LINK,
      MOODLE_LINK,
      CLASSROOM_LINK,
      SourceAccountRepository,
    ],
  },
  // Uma única instância do cofre (o mapa de pendentes é em memória): CHAVE_DO_CLIENTE e SIGAA_LINK a reutilizam.
  {
    provide: CofreSigaa,
    useFactory: (repo: SigaaCredentialRepository) =>
      new CofreSigaa(repo, (k) => new AesSecretCipher(k.toString('base64'))),
    inject: [SigaaCredentialRepository],
  },
  { provide: CHAVE_DO_CLIENTE, useExisting: CofreSigaa },
  { provide: SIGAA_LINK, useFactory: (cofre: CofreSigaa) => new SigaaLink(cofre), inject: [CofreSigaa] },
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
  {
    provide: MOODLE_LINK,
    useFactory: (accounts: SourceAccountRepository, identity: IdentityService) => new MoodleLink(accounts, identity),
    inject: [SourceAccountRepository, IdentityService],
  },

  // Bearer: chave de API (`plt_`) e token OAuth, nesta ordem. REST e MCP usam a mesma lista.
  {
    provide: AUTHENTICATORS,
    useFactory: (identity: IdentityService, oauth: Authenticator): Authenticator[] => [
      identity,
      oauth,
    ],
    inject: [IdentityService, OAUTH_ACCESS_AUTHENTICATOR],
  },
  {
    provide: MCP_AUTH,
    useFactory: (authenticators: Authenticator[]) => new AuthenticatorsMcpAuth(authenticators),
    inject: [AUTHENTICATORS],
  },
];

/** O que o módulo global exporta para o `McpModule` e o `BearerGuard`. */
export const mcpExports = [
  WebService,
  CLIENT_DIRECTORY,
  MCP_USE_CASES,
  MCP_AUTH,
  OAUTH_SERVICE,
  GOOGLE_LINK,
  MOODLE_LINK,
  CLASSROOM_LINK,
  SIGAA_LINK,
  AUTHENTICATORS,
];
