import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { OAuthController } from './oauth/oauth.controller';

/**
 * Só as rotas (/mcp e OAuth). As dependências (MCP_USE_CASES, MCP_AUTH, OAUTH_*, GOOGLE_LINK, MOODLE_LINK) vêm de
 * um módulo global da raiz de composição (`src/mcp-wiring.module.ts`); os testes usam `testing/mcp-testing.module.ts`.
 */
@Module({ controllers: [McpController, OAuthController] })
export class McpModule {}
