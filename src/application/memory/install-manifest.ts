import { z } from 'zod';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const https = z.string().url().refine((u) => u.startsWith('https://'), 'https');

/**
 * Manifesto do release do instalador. Quem o gera é o CI do repo `ufba-app/memory`, a partir do MESMO artefato que
 * gera o bootstrap (um só dono do hash, correção 2 do spike). A API só o valida e serve.
 */
export const InstallManifest = z.object({
  schema: z.literal(1),
  aiMemory: z.object({
    /** Versão fixa do ai-memory que o instalador instala (a v3.4.6 no desenho). */
    version: z.string().min(1),
    artifacts: z.record(z.string(), z.object({ url: https, sha256 })),
  }),
  installer: z.object({
    version: z.string().min(1),
    minVersion: z.string().min(1),
    files: z.record(z.string(), sha256),
  }),
});
export type InstallManifest = z.infer<typeof InstallManifest>;

export abstract class ManifestSource {
  /** JSON do manifesto como veio; erros de rede viram exceção (sem detalhes). */
  abstract fetch(): Promise<unknown>;
}

export class ManifestUnavailable extends Error {
  constructor() {
    super('install manifest unavailable');
  }
}

export const MANIFEST_TTL_MS = 10 * 60_000;

/** Serve o manifesto com cache de 10 min; se a origem cair, serve o último bom. Nunca serve algo que não valida. */
export class InstallManifests {
  private cached: { value: InstallManifest; at: number } | null = null;

  constructor(
    private readonly source: ManifestSource,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<InstallManifest> {
    const t = this.now();
    if (this.cached && t - this.cached.at < MANIFEST_TTL_MS) return this.cached.value;
    try {
      const value = InstallManifest.parse(await this.source.fetch());
      this.cached = { value, at: t };
      return value;
    } catch {
      if (this.cached) return this.cached.value;
      throw new ManifestUnavailable();
    }
  }
}
