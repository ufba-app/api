import { Global, Module } from '@nestjs/common';
import {
  CLASSROOM_LINK,
  GOOGLE_LINK,
  MOODLE_LINK,
  OAUTH_STORE,
  USER_DIRECTORY,
} from '../../../application/oauth/oauth-ports';
import { OAuthAccessTokenAuthenticator, OAuthService } from '../../../application/oauth/oauth.service';
import type { Authenticator } from '../../../application/ports/authenticator';
import { AuthenticatorsMcpAuth } from '../mcp-auth';
import { MCP_AUTH, MCP_USE_CASES } from '../mcp-ports';
import { McpModule } from '../mcp.module';
import { OAUTH_SERVICE } from '../oauth/oauth.controller';
import {
  MemoryOAuthStore,
  MemoryUserDirectory,
  StubClassroomLink,
  StubGoogleLink,
  StubMoodleLink,
} from './memory-oauth-store';
import { StubMcpUseCases } from './stub-mcp';

/** Chave de API aceita nos testes; qualquer outra credencial deve dar 401. */
export const TEST_API_KEY = 'plt_chave-de-teste';

const testApiKey: Authenticator = {
  authenticate: async (t) => (t === TEST_API_KEY ? { userId: 'user-api' } : null),
};

/** Liga o McpModule a stubs e a memória, sem banco. Usa os mesmos autenticadores em cadeia que a produção. */
@Global()
@Module({
  imports: [McpModule],
  providers: [
    { provide: MCP_USE_CASES, useClass: StubMcpUseCases },
    { provide: OAUTH_STORE, useClass: MemoryOAuthStore },
    { provide: USER_DIRECTORY, useClass: MemoryUserDirectory },
    { provide: GOOGLE_LINK, useClass: StubGoogleLink },
    { provide: MOODLE_LINK, useClass: StubMoodleLink },
    { provide: CLASSROOM_LINK, useClass: StubClassroomLink },
    {
      provide: OAUTH_SERVICE,
      useFactory: (s: MemoryOAuthStore, u: MemoryUserDirectory) => new OAuthService(s, u),
      inject: [OAUTH_STORE, USER_DIRECTORY],
    },
    {
      provide: MCP_AUTH,
      useFactory: (oauth: OAuthService) =>
        new AuthenticatorsMcpAuth([testApiKey, new OAuthAccessTokenAuthenticator(oauth)]),
      inject: [OAUTH_SERVICE],
    },
  ],
  exports: [MCP_USE_CASES, MCP_AUTH, OAUTH_SERVICE, OAUTH_STORE, GOOGLE_LINK, MOODLE_LINK, CLASSROOM_LINK],
})
export class McpTestingModule {}
