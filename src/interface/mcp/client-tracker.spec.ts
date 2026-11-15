import { McpClientTracker } from './client-tracker';

const init = (name: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1' } } });
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

describe('McpClientTracker', () => {
  it('fromBody lê o clientInfo.name do initialize (objeto ou lote); outras chamadas e nomes inválidos, nada', () => {
    expect(McpClientTracker.fromBody(init('claude-ai'))).toBe('claude-ai');
    expect(McpClientTracker.fromBody([list, init(' cursor-vscode ')])).toBe('cursor-vscode');
    expect(McpClientTracker.fromBody(list)).toBeUndefined();
    expect(McpClientTracker.fromBody(init(42))).toBeUndefined();
    expect(McpClientTracker.fromBody(init('   '))).toBeUndefined();
    expect(McpClientTracker.fromBody(null)).toBeUndefined();
    expect(McpClientTracker.fromBody(init('x'.repeat(500)))!.length).toBe(100);
  });

  it('guarda o nome por token: as requisições seguintes (sem clientInfo) o recebem; outro token não', () => {
    const t = new McpClientTracker();
    expect(t.resolve('Bearer aaa', list)).toBeUndefined();
    expect(t.resolve('Bearer aaa', init('claude-code'))).toBe('claude-code');
    expect(t.resolve('Bearer aaa', list)).toBe('claude-code');
    expect(t.resolve('Bearer bbb', list)).toBeUndefined();
    expect(t.resolve('Bearer aaa', init('cursor'))).toBe('cursor'); // um novo initialize substitui
    expect(t.resolve('Bearer aaa', list)).toBe('cursor');
  });

  it('sem Bearer não há o que guardar; o nome some depois de 24 h', () => {
    let now = 0;
    const t = new McpClientTracker(() => now);
    expect(t.resolve(undefined, init('claude-ai'))).toBeUndefined();
    t.resolve('Bearer aaa', init('claude-ai'));
    now = 24 * 60 * 60_000 - 1;
    expect(t.resolve('Bearer aaa', list)).toBe('claude-ai');
    now = 24 * 60 * 60_000 + 10;
    expect(t.resolve('Bearer aaa', list)).toBeUndefined();
  });
});
