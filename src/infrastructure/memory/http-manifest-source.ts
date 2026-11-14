import { ManifestSource } from '../../application/memory/install-manifest';

export const DEFAULT_MANIFEST_URL = 'https://github.com/ufba-app/memory/releases/latest/download/manifest.json';
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const MAX_BYTES = 256 * 1024;

/** Baixa o manifesto do release (GitHub). https obrigatório e só hosts do GitHub, mesmo depois de redirecionamentos. */
export class HttpManifestSource extends ManifestSource {
  private readonly url: URL;

  constructor(
    url: string = DEFAULT_MANIFEST_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.url = new URL(url);
    if (this.url.protocol !== 'https:' || !ALLOWED_HOSTS.has(this.url.hostname)) {
      throw new Error('MEMORY_INSTALL_MANIFEST_URL deve ser https em github.com');
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpManifestSource {
    return new HttpManifestSource(env.MEMORY_INSTALL_MANIFEST_URL || DEFAULT_MANIFEST_URL);
  }

  async fetch(): Promise<unknown> {
    const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    const final = new URL(res.url || this.url.toString());
    if (!res.ok || final.protocol !== 'https:' || !ALLOWED_HOSTS.has(final.hostname)) throw new Error('manifest');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('manifest too large');
    return JSON.parse(text) as unknown;
  }
}
