import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-tools';
import type { McpPrincipal, McpUseCases } from './mcp-ports';

async function servidor(p: McpPrincipal, uc: Partial<McpUseCases>) {
  const server = buildMcpServer(uc as McpUseCases, p);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('ferramenta postar_forum', () => {
  it('sem a permissão moodle.forum_write a ferramenta nem aparece', async () => {
    const c = await servidor({ userId: 'u1' }, {});
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('postar_forum');
    const c2 = await servidor({ userId: 'u1', permissions: new Set(['siasb.schedule_write']) }, {});
    expect((await c2.listTools()).tools.map((t) => t.name)).not.toContain('postar_forum');
  });

  it('com a permissão ela aparece, marcada como escrita e não destrutiva', async () => {
    const c = await servidor({ userId: 'u1', permissions: new Set(['moodle.forum_write']) }, {});
    const t = (await c.listTools()).tools.find((x) => x.name === 'postar_forum')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(t.annotations?.title).toBe(t.title);
  });

  it('chama o caso de uso com os argumentos e devolve o resultado', async () => {
    const postarForum = jest.fn(async () => ({ postado: true, discussaoId: '42' }));
    const c = await servidor({ userId: 'u1', permissions: new Set(['moodle.forum_write']) }, { postarForum });
    const r = await c.callTool({ name: 'postar_forum', arguments: { forumId: '77', titulo: 'Dúvida', mensagem: 'Oi' } });
    expect(postarForum).toHaveBeenCalledWith(expect.anything(), { forumId: '77', titulo: 'Dúvida', mensagem: 'Oi' });
    expect(r.isError).toBeFalsy();
    const texto = (r.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(texto)).toEqual({ postado: true, discussaoId: '42' });
  });

  it('erro do caso de uso volta como erro da ferramenta, com a mensagem', async () => {
    const postarForum = jest.fn(async () => {
      throw new Error('O título precisa ter de 1 a 255 caracteres.');
    });
    const c = await servidor({ userId: 'u1', permissions: new Set(['moodle.forum_write']) }, { postarForum });
    const r = await c.callTool({ name: 'postar_forum', arguments: { forumId: '77', titulo: '', mensagem: 'Oi' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('O título precisa');
  });
});
