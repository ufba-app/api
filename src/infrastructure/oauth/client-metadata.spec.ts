import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMetadataClientId, sanitizeName } from '../../application/oauth/client-directory';
import { FileVerifiedApps, HttpsClientMetadataFetcher, sniffImage } from './client-metadata';
import { isBlockedAddress, safeGet } from './safe-fetch';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

describe('busca segura de metadados de cliente', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.210', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '224.0.0.1'])(
    'bloqueia %s',
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permite %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it('recusa http, porta estranha, credenciais e IP interno literal sem abrir conexão', async () => {
    const o = { maxBytes: 10, timeoutMs: 100, accept: '*/*' };
    await expect(safeGet('http://example.com/x', o)).rejects.toThrow('https');
    await expect(safeGet('https://example.com:8443/x', o)).rejects.toThrow('https');
    await expect(safeGet('https://u:p@example.com/x', o)).rejects.toThrow('https');
    await expect(safeGet('https://127.0.0.1/x', o)).rejects.toThrow('bloqueado');
    await expect(safeGet('https://[::1]/x', o)).rejects.toThrow('bloqueado');
    await expect(safeGet('https://[::ffff:127.0.0.1]/x', o)).rejects.toThrow('bloqueado');
    await expect(safeGet('https://8.8.8.8/x', o)).rejects.toThrow('bloqueado');
  });

  it('tipo da imagem pelos bytes: PNG/JPEG/WebP sim, SVG e HTML não', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
  });

  it('logo com bytes de SVG é descartado mesmo com content-type de imagem', async () => {
    const f = new HttpsClientMetadataFetcher(async () => ({ status: 200, contentType: 'image/png', body: Buffer.from('<svg/>') }));
    expect(await f.fetchLogo('https://x.example/logo.png')).toBeNull();
  });

  it('nome: sem bidi/controle, espaços colapsados, até 60 caracteres', () => {
    expect(sanitizeName('  Meu‮  App\u0007 ')).toBe('Meu App');
    expect(sanitizeName('a'.repeat(80))).toHaveLength(60);
    expect(sanitizeName(42)).toBeUndefined();
    expect(sanitizeName('​')).toBeUndefined();
  });

  it('client_id de documento: só URL https com caminho', () => {
    expect(isMetadataClientId('https://claude.ai/oauth/client.json')).toBe(true);
    expect(isMetadataClientId('https://claude.ai/')).toBe(false);
    expect(isMetadataClientId('http://claude.ai/c.json')).toBe(false);
    expect(isMetadataClientId('abc123')).toBe(false);
  });

  it('lista de verificados: domínio e subdomínios; logo validado no boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verified-'));
    mkdirSync(join(dir, 'verified-logos'));
    writeFileSync(join(dir, 'verified-logos', 'c.png'), PNG);
    writeFileSync(join(dir, 'verified-apps.json'), JSON.stringify([{ domain: 'Claude.ai', name: 'Claude', logo: 'c.png' }]));
    const v = new FileVerifiedApps(dir);
    expect(v.match('claude.ai')?.name).toBe('Claude');
    expect(v.match('mcp.claude.ai')?.name).toBe('Claude');
    expect(v.match('notclaude.ai')).toBeUndefined();
    expect(v.logo(v.match('claude.ai')!.logoHash!)?.mime).toBe('image/png');

    writeFileSync(join(dir, 'verified-logos', 'bad.svg'), '<svg/>');
    writeFileSync(join(dir, 'verified-apps.json'), JSON.stringify([{ domain: 'x.com', logo: 'bad.svg' }]));
    expect(() => new FileVerifiedApps(dir)).toThrow('logo inválido');
  });

  it('o config/verified-apps.json do repo carrega', () => {
    expect(new FileVerifiedApps().match('claude.ai')?.name).toBe('Claude');
  });
});
