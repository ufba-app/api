import { sanitizeName } from '../../domain/oauth/client-name';
import { createHash } from 'node:crypto';
import type { ClientLogo, OAuthClient, OAuthStore } from './oauth-ports';
import { isValidRedirectUri, type ClientResolver } from './oauth.service';

export const CLIENT_METADATA_FETCHER = Symbol('CLIENT_METADATA_FETCHER');
export const VERIFIED_APPS = Symbol('VERIFIED_APPS');

export type LogoMime = ClientLogo['mime'];

/**
 * Busca segura na internet (só https, sem IP interno, sem redirect, com tempo e tamanho máximos). Quem implementa é
 * a infraestrutura.
 */
export interface ClientMetadataFetcher {
  /** JSON do documento de metadados (lança se a busca falhar). */
  fetchDocument(url: string): Promise<unknown>;
  /** Imagem validada pelos bytes (PNG, JPEG ou WebP, até 256 KB); null se não der. */
  fetchLogo(url: string): Promise<{ mime: LogoMime; bytes: Buffer } | null>;
}

export interface VerifiedApp {
  domain: string;
  name?: string;
  logoHash?: string;
}

/** Lista curada de apps verificados (`config/verified-apps.json`, mudada por PR). */
export interface VerifiedAppsPort {
  /** Entrada cujo domínio é o host, ou um domínio pai dele. */
  match(host: string): VerifiedApp | undefined;
  logo(hash: string): { mime: LogoMime; bytes: Buffer } | null;
}

/** Como a tela de autorização e a lista de apps mostram um cliente. */
export interface ClientView {
  domain: string;
  redirectUri: string;
  name: string | null;
  logoUrl: string | null;
  verified: boolean;
  metadata: 'present' | 'absent';
}

const CACHE_MS = 60 * 60 * 1000;

/**
 * Client ID Metadata Document (MCP): o client_id é uma URL https com caminho, sem fragmento nem credenciais.
 */
export function isMetadataClientId(id: string): boolean {
  try {
    const u = new URL(id);
    return u.protocol === 'https:' && !u.hash && !u.username && !u.password && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function logoHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve clientes: os do /register vêm do banco; os de documento de metadados (client_id = URL https) são buscados,
 * validados (client_id igual à URL, redirect_uris válidos) e guardados (com o logo) para a lista de apps autorizados.
 * O `client_name` do /register NUNCA é mostrado: qualquer um escolhe o nome que quiser.
 */
export class ClientDirectory implements ClientResolver {
  private readonly cache = new Map<string, { client: OAuthClient; until: number }>();

  constructor(
    private readonly store: OAuthStore,
    private readonly fetcher: ClientMetadataFetcher,
    private readonly verified: VerifiedAppsPort,
    private readonly publicUrl: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(clientId: string): Promise<OAuthClient | null> {
    if (!isMetadataClientId(clientId)) return this.store.getClient(clientId);
    const hit = this.cache.get(clientId);
    if (hit && hit.until > this.now()) return hit.client;

    let doc: Record<string, unknown>;
    try {
      const raw = await this.fetcher.fetchDocument(clientId);
      if (!raw || typeof raw !== 'object') return null;
      doc = raw as Record<string, unknown>;
    } catch {
      return null;
    }
    const uris = doc.redirect_uris;
    if (doc.client_id !== clientId) return null;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && isValidRedirectUri(u))) {
      return null;
    }

    let logo: ClientLogo | null = null;
    if (typeof doc.logo_uri === 'string' && doc.logo_uri.startsWith('https://')) {
      const img = await this.fetcher.fetchLogo(doc.logo_uri).catch(() => null);
      if (img) logo = { hash: logoHash(img.bytes), mime: img.mime, bytes: img.bytes };
    }
    const client: OAuthClient = {
      clientId,
      clientName: sanitizeName(doc.client_name),
      redirectUris: uris as string[],
      createdAt: this.now(),
      fromMetadata: true,
    };
    await this.store.upsertClient({ ...client, logo });
    const view: OAuthClient = { ...client, ...(logo ? { logoHash: logo.hash } : {}) };
    this.cache.set(clientId, { client: view, until: this.now() + CACHE_MS });
    return view;
  }

  /** Domínio sempre do redirect_uri (ASCII/punycode); nome e logo da lista verificada, senão do documento. */
  describe(client: OAuthClient, redirectUri: string): ClientView {
    const domain = new URL(redirectUri).hostname;
    const v = this.verified.match(domain);
    const fromDoc = client.fromMetadata === true;
    const name = v?.name ?? (fromDoc ? (client.clientName ?? null) : null);
    const hash = v?.logoHash ?? (fromDoc ? client.logoHash : undefined);
    return {
      domain,
      redirectUri,
      name,
      logoUrl: hash ? `${this.publicUrl().replace(/\/+$/, '')}/client-logos/${hash}` : null,
      verified: !!v,
      metadata: fromDoc ? 'present' : 'absent',
    };
  }

  async logo(hash: string): Promise<{ mime: LogoMime; bytes: Buffer } | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return this.verified.logo(hash) ?? (await this.store.getClientLogo(hash));
  }
}

export { sanitizeName };
