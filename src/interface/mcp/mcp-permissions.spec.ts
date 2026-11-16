import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Authenticator } from '../../application/ports/authenticator';
import { AuthenticatorsMcpAuth } from './mcp-auth';
import type { McpPrincipal } from './mcp-ports';
import { registerPermissionedTool } from './mcp-tools';

/** Servidor com UMA ferramenta de escrita de brinquedo, atrás da chave `siasb.schedule_write`. */
async function toolsFor(p: McpPrincipal): Promise<string[]> {
  const server = new McpServer({ name: 'teste', version: '0' });
  server.registerTool('leitura', { description: 'leitura', inputSchema: {} }, () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  registerPermissionedTool(p, 'siasb.schedule_write', () =>
    server.registerTool('agendar_sessao', { description: 'escrita', inputSchema: {} }, () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe('ferramentas de escrita atrás de permissão', () => {
  it('sem a chave ligada (ou sem conjunto de permissões) a ferramenta nem é registrada', async () => {
    expect(await toolsFor({ userId: 'u1' })).toEqual(['leitura']);
    expect(await toolsFor({ userId: 'u1', permissions: new Set() })).toEqual(['leitura']);
    expect(await toolsFor({ userId: 'u1', permissions: new Set(['siasb.procedures_write']) })).toEqual(['leitura']);
  });

  it('com a chave ligada a ferramenta aparece', async () => {
    expect(await toolsFor({ userId: 'u1', permissions: new Set(['siasb.schedule_write']) })).toEqual(['agendar_sessao', 'leitura']);
  });
});

describe('AuthenticatorsMcpAuth resolve as permissões da pessoa a cada requisição', () => {
  const authn: Authenticator = {
    authenticate: async (t: string) => (t === 'tok' ? { userId: 'u1', clientId: 'app-a' } : t === 'plt' ? { userId: 'u1' } : null),
  } as unknown as Authenticator;

  it('coloca no principal as chaves concedidas ao APP do token; conceder e revogar vale na hora', async () => {
    let enabled = new Set<string>();
    const asked: Array<[string, string | undefined]> = [];
    const auth = new AuthenticatorsMcpAuth([authn], {
      grantedKeys: async (u, c) => {
        asked.push([u, c]);
        return c === 'app-a' ? enabled : new Set();
      },
    });
    expect((await auth.authenticate('Bearer tok'))?.permissions?.size).toBe(0);
    enabled = new Set(['siasb.schedule_write']);
    expect([...((await auth.authenticate('Bearer tok'))?.permissions ?? [])]).toEqual(['siasb.schedule_write']);
    enabled = new Set();
    expect((await auth.authenticate('Bearer tok'))?.permissions?.size).toBe(0);
    expect(asked.every(([, c]) => c === 'app-a')).toBe(true);
  });

  it('credencial sem app (chave de API) não herda as permissões de nenhum app', async () => {
    const auth = new AuthenticatorsMcpAuth([authn], { grantedKeys: async (_u, c) => (c ? new Set(['siasb.schedule_write']) : new Set()) });
    expect((await auth.authenticate('Bearer plt'))?.permissions?.size).toBe(0);
    expect((await auth.authenticate('Bearer tok'))?.permissions?.size).toBe(1);
  });

  it('credencial inválida continua sendo null', async () => {
    const auth = new AuthenticatorsMcpAuth([authn], { grantedKeys: async () => new Set() });
    expect(await auth.authenticate('Bearer outro')).toBeNull();
    expect(await auth.authenticate(undefined)).toBeNull();
  });
});
