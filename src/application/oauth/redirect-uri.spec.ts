import { isLocalRedirect, redirectUriAllowed } from './redirect-uri';

const CLAUDE_CODE = ['http://localhost/callback', 'http://127.0.0.1/callback'];

describe('redirectUriAllowed (RFC 8252: porta de loopback livre)', () => {
  it('porta aleatória aceita para loopback http (localhost e 127.0.0.1) registrado sem porta', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:51234/callback')).toBe(true);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://127.0.0.1:60001/callback')).toBe(true);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:1/callback')).toBe(true);
  });

  it('o URI exato (sem porta ou com a mesma porta registrada) continua aceito', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost/callback')).toBe(true);
    expect(redirectUriAllowed(['http://localhost:3000/cb'], 'http://localhost:3000/cb')).toBe(true);
  });

  it('registrado com porta: outra porta também vale (a porta é ignorada nos dois lados)', () => {
    expect(redirectUriAllowed(['http://localhost:3000/cb'], 'http://localhost:4444/cb')).toBe(true);
  });

  it('IPv6 loopback [::1] também', () => {
    expect(redirectUriAllowed(['http://[::1]/callback'], 'http://[::1]:5000/callback')).toBe(true);
  });

  it('host diferente continua recusado (inclusive outro loopback e domínio parecido)', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://evil.test:5000/callback')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost.evil.test:5000/callback')).toBe(false);
    expect(redirectUriAllowed(['http://localhost/callback'], 'http://127.0.0.1:5000/callback')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://[::1]:5000/callback')).toBe(false);
  });

  it('path ou query diferentes continuam recusados', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:5000/outro')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:5000/callback/x')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:5000/callback?x=1')).toBe(false);
    expect(redirectUriAllowed(['http://localhost/cb?a=1'], 'http://localhost:5000/cb?a=2')).toBe(false);
    expect(redirectUriAllowed(['http://localhost/cb?a=1'], 'http://localhost:5000/cb?a=1')).toBe(true);
  });

  it('https em localhost sem registro de https continua recusado; e o scheme tem de ser o mesmo', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'https://localhost:5000/callback')).toBe(false);
    expect(redirectUriAllowed(['https://localhost/callback'], 'http://localhost:5000/callback')).toBe(false);
    expect(redirectUriAllowed(['https://localhost/callback'], 'https://localhost:5000/callback')).toBe(false);
  });

  it('porta em host que não é loopback continua exata (https e http)', () => {
    expect(redirectUriAllowed(['https://app.exemplo.com/cb'], 'https://app.exemplo.com:8443/cb')).toBe(false);
    expect(redirectUriAllowed(['http://app.exemplo.com/cb'], 'http://app.exemplo.com:8080/cb')).toBe(false);
    expect(redirectUriAllowed(['https://app.exemplo.com/cb'], 'https://app.exemplo.com/cb')).toBe(true);
  });

  it('não vale com credenciais, fragmento, URI inválido ou ausente', () => {
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://user:pw@localhost:5000/callback')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'http://localhost:5000/callback#frag')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, 'não é uma url')).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, undefined)).toBe(false);
    expect(redirectUriAllowed(CLAUDE_CODE, '')).toBe(false);
  });

  it('lista registrada vazia ou sem loopback: nada além do exato', () => {
    expect(redirectUriAllowed([], 'http://localhost:5000/callback')).toBe(false);
    expect(redirectUriAllowed(['https://claude.ai/api/mcp/auth_callback'], 'http://localhost:5000/callback')).toBe(false);
    expect(redirectUriAllowed(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });
});

describe('isLocalRedirect (para onde o código vai, não quem é o cliente)', () => {
  it.each([
    ['http://localhost:5000/cb', true],
    ['http://127.0.0.1/cb', true],
    ['http://[::1]:9/cb', true],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', true],
    ['com.exemplo.app:/cb', true],
    ['https://localhost/cb', false],
    ['https://claude.ai/api/mcp/auth_callback', false],
    ['http://evil.test/cb', false],
    ['http://localhost.evil.test/cb', false],
    ['não é url', false],
  ])('%s -> %s', (uri, esperado) => {
    expect(isLocalRedirect(uri)).toBe(esperado);
  });
});
