import { ClientDirectory, type ClientMetadataFetcher, type VerifiedAppsPort } from './client-directory';
import type { OAuthClient, OAuthStore } from './oauth-ports';

const verified: VerifiedAppsPort = {
  match: (host) => {
    const h = host.toLowerCase();
    return h === 'claude.ai' || h.endsWith('.claude.ai') ? { domain: 'claude.ai', name: 'Claude' } : undefined;
  },
  logo: () => null,
};
const fetcher: ClientMetadataFetcher = { fetchDocument: async () => ({}), fetchLogo: async () => null };

const dir = new ClientDirectory({} as OAuthStore, fetcher, verified, () => 'https://api.ufba.app');

const cimd = (clientId: string, name: string | undefined, uris: string[]): OAuthClient => ({
  clientId,
  clientName: name,
  redirectUris: uris,
  createdAt: 0,
  fromMetadata: true,
});
const dcr = (uris: string[], name?: string): OAuthClient => ({ clientId: 'abc123', clientName: name, redirectUris: uris, createdAt: 0 });

describe('ClientDirectory.describe: local e verificado', () => {
  it('CIMD do Claude Code: verificado pelo HOST do documento (claude.ai), mesmo com redirect em localhost; e roda no computador', () => {
    const c = cimd('https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code', ['http://localhost/callback']);
    expect(dir.describe(c, 'http://localhost:51234/callback')).toMatchObject({
      domain: 'localhost',
      local: true,
      verified: true,
      name: 'Claude',
      metadata: 'present',
    });
    expect(dir.verifiedByClientId(c)).toMatchObject({ domain: 'claude.ai' });
  });

  it('CIMD de outro host que se chama "Claude Code" NÃO ganha o selo (nome é do cliente), mas é local', () => {
    const c = cimd('https://evil.example/client.json', 'Claude Code', ['http://localhost/callback']);
    const v = dir.describe(c, 'http://localhost:51234/callback');
    expect(v).toMatchObject({ local: true, verified: false, name: 'Claude Code' });
    expect(dir.verifiedByClientId(c)).toBeUndefined();
  });

  it('loopback NÃO é verificação: DCR em localhost é local, sem selo e sem nome', () => {
    const v = dir.describe(dcr(['http://localhost/cb'], 'Claude Code'), 'http://localhost:9/cb');
    expect(v).toMatchObject({ local: true, verified: false, name: null, domain: 'localhost' });
  });

  it.each([['http://127.0.0.1:5000/cb'], ['http://[::1]:5000/cb'], ['cursor://anysphere.cursor-retrieval/oauth/callback']])(
    '%s é local',
    (uri) => {
      expect(dir.describe(dcr([uri]), uri)).toMatchObject({ local: true, verified: false });
    },
  );

  it('esquema privado sem host: o esquema faz o papel de domínio', () => {
    expect(dir.describe(dcr(['com.exemplo.app:/cb']), 'com.exemplo.app:/cb')).toMatchObject({ domain: 'com.exemplo.app', local: true });
  });

  it('https não é local; redirect em claude.ai continua verificado pelo domínio', () => {
    expect(dir.describe(dcr(['https://app.exemplo.com/cb']), 'https://app.exemplo.com/cb')).toMatchObject({ local: false, verified: false, name: null });
    expect(dir.describe(dcr(['https://claude.ai/api/mcp/auth_callback']), 'https://claude.ai/api/mcp/auth_callback')).toMatchObject({
      local: false,
      verified: true,
      name: 'Claude',
    });
  });

  it('só cliente CIMD é verificado pelo client_id: um DCR não herda selo por ter client_id parecido', () => {
    const c: OAuthClient = { ...dcr(['http://localhost/cb']), clientId: 'https://claude.ai/qualquer' };
    expect(dir.verifiedByClientId(c)).toBeUndefined();
    expect(dir.describe(c, 'http://localhost:1/cb')).toMatchObject({ verified: false });
  });
});
