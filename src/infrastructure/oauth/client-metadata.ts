import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  logoHash,
  type ClientMetadataFetcher,
  type LogoMime,
  type VerifiedApp,
  type VerifiedAppsPort,
} from '../../application/oauth/client-directory';
import { safeGet } from './safe-fetch';

const DOC_MAX_BYTES = 64 * 1024;
export const LOGO_MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 3000;

/** Tipo da imagem pelos bytes iniciais (nunca pelo header). SVG e o resto: null. */
export function sniffImage(b: Buffer): LogoMime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export class HttpsClientMetadataFetcher implements ClientMetadataFetcher {
  constructor(private readonly get: typeof safeGet = safeGet) {}

  async fetchDocument(url: string): Promise<unknown> {
    const res = await this.get(url, { maxBytes: DOC_MAX_BYTES, timeoutMs: TIMEOUT_MS, accept: 'application/json' });
    return JSON.parse(res.body.toString('utf8'));
  }

  async fetchLogo(url: string): Promise<{ mime: LogoMime; bytes: Buffer } | null> {
    try {
      const res = await this.get(url, { maxBytes: LOGO_MAX_BYTES, timeoutMs: TIMEOUT_MS, accept: 'image/png,image/jpeg,image/webp' });
      const mime = sniffImage(res.body);
      return mime ? { mime, bytes: res.body } : null;
    } catch {
      return null;
    }
  }
}

interface Entry {
  domain: string;
  name?: string;
  logo?: string;
}

/**
 * `config/verified-apps.json` (+ logos em `config/verified-logos/`), lido uma vez no boot. Arquivo ausente = lista
 * vazia. Entrada inválida derruba o boot: a lista é curada por PR, erro nela tem que aparecer.
 */
export class FileVerifiedApps implements VerifiedAppsPort {
  private readonly apps: VerifiedApp[] = [];
  private readonly logos = new Map<string, { mime: LogoMime; bytes: Buffer }>();

  constructor(dir = join(process.cwd(), 'config')) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, 'verified-apps.json'), 'utf8');
    } catch {
      return;
    }
    const entries = JSON.parse(raw) as Entry[];
    if (!Array.isArray(entries)) throw new Error('verified-apps.json: esperado um array');
    for (const e of entries) {
      const domain = typeof e.domain === 'string' ? e.domain.trim().toLowerCase() : '';
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`verified-apps.json: domínio inválido "${e.domain}"`);
      const app: VerifiedApp = { domain };
      if (typeof e.name === 'string' && e.name.trim()) app.name = e.name.trim();
      if (typeof e.logo === 'string' && e.logo) {
        const bytes = readFileSync(join(dir, 'verified-logos', e.logo.replace(/[/\\]/g, '')));
        const mime = sniffImage(bytes);
        if (!mime || bytes.length > LOGO_MAX_BYTES) throw new Error(`verified-apps.json: logo inválido "${e.logo}"`);
        app.logoHash = logoHash(bytes);
        this.logos.set(app.logoHash, { mime, bytes });
      }
      this.apps.push(app);
    }
  }

  match(host: string): VerifiedApp | undefined {
    const h = host.toLowerCase();
    return this.apps.find((a) => h === a.domain || h.endsWith('.' + a.domain));
  }

  logo(hash: string) {
    return this.logos.get(hash) ?? null;
  }
}
