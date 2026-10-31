import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { MCP_AUTH, MCP_USE_CASES } from './mcp-ports';
import { StubMcpAuth, StubMcpUseCases } from './stub-mcp';
import { OAUTH_SERVICE, OAuthController } from './oauth/oauth.controller';
import {
  GOOGLE_LINK,
  MOODLE_LINK,
  OAUTH_STORE,
  OAuthStore,
  USER_DIRECTORY,
  UserDirectory,
} from './oauth/oauth-ports';
import {
  MemoryOAuthStore,
  MemoryUserDirectory,
  StubGoogleLink,
  StubMoodleLink,
} from './oauth/memory-oauth-store';
import { OAuthService } from './oauth/oauth.service';
import { OAuthOrApiKeyAuth } from './oauth/oauth-token-auth';

/**
 * Providers são stubs/memória até o Núcleo publicar casos de uso, guard de chave de API,
 * usuários e persistência de OAuth. Para ligar, troque: MCP_USE_CASES, USER_DIRECTORY, OAUTH_STORE,
 * GOOGLE_LINK, MOODLE_LINK e o `StubMcpAuth` (verificador de chave de API) abaixo (ver docs/MCP.md).
 */
@Module({
  controllers: [McpController, OAuthController],
  providers: [
    { provide: MCP_USE_CASES, useClass: StubMcpUseCases },
    { provide: OAUTH_STORE, useClass: MemoryOAuthStore },
    { provide: USER_DIRECTORY, useClass: MemoryUserDirectory },
    { provide: GOOGLE_LINK, useClass: StubGoogleLink },
    { provide: MOODLE_LINK, useClass: StubMoodleLink },
    {
      provide: OAUTH_SERVICE,
      inject: [OAUTH_STORE, USER_DIRECTORY],
      useFactory: (store: OAuthStore, users: UserDirectory) => new OAuthService(store, users),
    },
    {
      provide: MCP_AUTH,
      inject: [OAUTH_SERVICE],
      useFactory: (oauth: OAuthService) => new OAuthOrApiKeyAuth(oauth, new StubMcpAuth()),
    },
  ],
})
export class McpModule {}
