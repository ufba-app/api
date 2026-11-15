import { Controller, Delete, Get, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { buildMcpServer } from './mcp-tools';
import { baseUrl } from './oauth/base-url';
import { resolveSiasbFlag } from './clinica-tools';
import { MCP_AUTH, MCP_CLINICA, MCP_MEMORY, MCP_USE_CASES, McpAuth, McpClinica, McpMemory, McpUseCases } from './mcp-ports';

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Transporte Streamable HTTP sem sessão: um servidor e um transporte por requisição. */
@Controller('mcp')
export class McpController {
  constructor(
    @Inject(MCP_USE_CASES) private readonly useCases: McpUseCases,
    @Inject(MCP_AUTH) private readonly auth: McpAuth,
    @Optional() @Inject(MCP_MEMORY) private readonly memory?: McpMemory,
    @Optional() @Inject(MCP_CLINICA) private readonly clinica?: McpClinica,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const principal = await this.auth.authenticate(req.headers.authorization);
    if (!principal) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
      );
      rpcError(res, 401, -32001, 'Não autenticado: envie Authorization: Bearer <token>');
      return;
    }

    const siasb = await resolveSiasbFlag(this.clinica, principal.userId);
    const server = buildMcpServer(this.useCases, { ...principal, baseUrl: baseUrl(req), siasb }, this.memory, this.clinica);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @Get()
  naoSuportado(@Res() res: Response): void {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, -32000, 'Use POST /mcp');
  }

  @Delete()
  naoSuportadoDelete(@Res() res: Response): void {
    res.setHeader('Allow', 'POST');
    rpcError(res, 405, -32000, 'Use POST /mcp');
  }
}
