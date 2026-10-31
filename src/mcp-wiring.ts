import type { Provider } from '@nestjs/common';
import { HistoricoService } from './application/academic/historico.service';
import { IdentityService } from './application/identity/identity.service';
import {
  GOOGLE_LINK,
  MOODLE_LINK,
  OAUTH_STORE,
  USER_DIRECTORY,
  type OAuthStore,
  type UserDirectory,
} from './application/oauth/oauth-ports';
import { OAuthAccessTokenAuthenticator, OAuthService } from './application/oauth/oauth.service';
import {
  AttachmentLookup,
  AttachmentReaders,
  TranscriptRepository,
  TranscriptSource,
} from './application/ports/academic-ports';
import { AUTHENTICATORS, type Authenticator } from './application/ports/authenticator';
import { HISTORY_EXTRACTOR, type HistoryExtractor } from './application/ports/history-extractor';
import { ReadRepository, SourceAccountRepository } from './application/ports/repositories';
import { SecretCipher } from './application/ports/secret-cipher';
import { SourceRegistry } from './application/ports/source-gateway';
import { AnexoService } from './application/read/anexo.service';
import { LeituraService } from './application/read/leitura.service';
import { SincronizarService } from './application/sync/sincronizar.service';
import { SourceAttachmentReaders } from './infrastructure/sources/attachment-readers';
import { DriveAttachmentReader } from './infrastructure/sources/classroom/drive-attachment-reader';
import { GoogleAuth, GoogleHttp } from './infrastructure/sources/google/google-http';
import { GoogleOAuthLink } from './infrastructure/sources/google/google-oauth-link';
import { MoodleAttachmentReader } from './infrastructure/sources/moodle/moodle-attachment-reader';
import { MoodleLink } from './infrastructure/sources/moodle/moodle-link';
import { createHistoryExtractor } from './infrastructure/sources/sigaa/history/create-history-extractor';
import type { SigaaGateway } from './infrastructure/sources/sigaa/sigaa-gateway';
import { SigaaTranscriptSource } from './infrastructure/sources/sigaa/sigaa-transcript-source';
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
  // Histórico: o extrator (IA) é criado só no uso, para o serviço subir sem AI_API_KEY.
  {
    provide: HISTORY_EXTRACTOR,
    useFactory: (): HistoryExtractor => ({
      extract: (pdf) => createHistoryExtractor().extract(pdf),
    }),
  },
  {
    provide: TranscriptSource,
    useFactory: (registry: SourceRegistry) => {
      const sigaa = registry.get('SIGAA');
      if (!sigaa) throw new Error('SigaaGateway não registrado');
      return new SigaaTranscriptSource(sigaa as SigaaGateway);
    },
    inject: [SourceRegistry],
  },
  {
    provide: HistoricoService,
    useFactory: (
      read: ReadRepository,
      transcripts: TranscriptRepository,
      source: TranscriptSource,
      extractor: HistoryExtractor,
    ) => new HistoricoService(read, transcripts, source, extractor),
    inject: [ReadRepository, TranscriptRepository, TranscriptSource, HISTORY_EXTRACTOR],
  },
  {
    provide: AttachmentReaders,
    useFactory: () => {
      const drive =
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
          ? new DriveAttachmentReader(new GoogleHttp(GoogleAuth.fromEnv()))
          : undefined;
      return new SourceAttachmentReaders({ drive, moodle: new MoodleAttachmentReader() });
    },
  },
  {
    provide: AnexoService,
    useFactory: (
      lookup: AttachmentLookup,
      accounts: SourceAccountRepository,
      cipher: SecretCipher,
      readers: AttachmentReaders,
    ) => new AnexoService(lookup, accounts, cipher, readers),
    inject: [AttachmentLookup, SourceAccountRepository, SecretCipher, AttachmentReaders],
  },
  {
    provide: MCP_USE_CASES,
    useFactory: (
      sincronizar: SincronizarService,
      leitura: LeituraService,
      historico: HistoricoService,
      anexos: AnexoService,
    ) => new McpUseCasesImpl(sincronizar, leitura, historico, anexos),
    inject: [SincronizarService, LeituraService, HistoricoService, AnexoService],
  },

  // OAuth 2.1 do serviço (store e usuários persistentes vêm do PersistenceModule).
  {
    provide: OAUTH_SERVICE,
    useFactory: (store: OAuthStore, users: UserDirectory) => new OAuthService(store, users),
    inject: [OAUTH_STORE, USER_DIRECTORY],
  },
  {
    provide: OAUTH_ACCESS_AUTHENTICATOR,
    useFactory: (oauth: OAuthService) => new OAuthAccessTokenAuthenticator(oauth),
    inject: [OAUTH_SERVICE],
  },
  {
    provide: GOOGLE_LINK,
    useFactory: (identity: IdentityService, accounts: SourceAccountRepository) =>
      new GoogleOAuthLink(identity, accounts),
    inject: [IdentityService, SourceAccountRepository],
  },
  {
    provide: MOODLE_LINK,
    useFactory: (accounts: SourceAccountRepository) => new MoodleLink(accounts),
    inject: [SourceAccountRepository],
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
  MCP_USE_CASES,
  MCP_AUTH,
  OAUTH_SERVICE,
  GOOGLE_LINK,
  MOODLE_LINK,
  AUTHENTICATORS,
  HistoricoService,
  AnexoService,
];
