import { Injectable } from '@nestjs/common';
import type {
  AuthCode,
  OAuthClient,
  OAuthStore,
  PendingAuthorization,
  TokenRecord,
  UserDirectory,
} from '../../application/oauth/oauth-ports';
import { sha256Base64Url } from '../../application/oauth/pkce';
import { PrismaService } from './prisma.service';

/** OAuth do serviço no Postgres. Authorization codes e tokens só existem como hash SHA-256. */
@Injectable()
export class PrismaOAuthStore implements OAuthStore {
  constructor(private readonly prisma: PrismaService) {}

  async saveClient(c: OAuthClient): Promise<void> {
    await this.prisma.oAuthClient.create({
      data: {
        clientId: c.clientId,
        clientName: c.clientName ?? null,
        redirectUris: c.redirectUris,
        createdAt: new Date(c.createdAt),
      },
    });
  }

  async upsertClient(c: OAuthClient): Promise<void> {
    const logo =
      c.logo === undefined
        ? {}
        : c.logo === null
          ? { logoHash: null, logoMime: null, logoBytes: null }
          : { logoHash: c.logo.hash, logoMime: c.logo.mime, logoBytes: new Uint8Array(c.logo.bytes) };
    const data = { clientName: c.clientName ?? null, redirectUris: c.redirectUris, ...logo };
    await this.prisma.oAuthClient.upsert({
      where: { clientId: c.clientId },
      create: { clientId: c.clientId, createdAt: new Date(c.createdAt), ...data },
      update: data,
    });
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const r = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
      select: { clientId: true, clientName: true, redirectUris: true, createdAt: true, logoHash: true },
    });
    return r
      ? {
          clientId: r.clientId,
          clientName: r.clientName ?? undefined,
          redirectUris: r.redirectUris,
          createdAt: r.createdAt.getTime(),
          ...(r.logoHash ? { logoHash: r.logoHash } : {}),
          ...(/^https:\/\//.test(r.clientId) ? { fromMetadata: true } : {}),
        }
      : null;
  }

  async getClientLogo(hash: string): Promise<{ mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Buffer } | null> {
    const r = await this.prisma.oAuthClient.findFirst({
      where: { logoHash: hash },
      select: { logoMime: true, logoBytes: true },
    });
    if (!r?.logoMime || !r.logoBytes) return null;
    return { mime: r.logoMime as 'image/png' | 'image/jpeg' | 'image/webp', bytes: Buffer.from(r.logoBytes) };
  }

  async savePending(p: PendingAuthorization): Promise<void> {
    const data = {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      state: p.state ?? null,
      codeChallenge: p.codeChallenge,
      scope: p.scope ?? null,
      userId: p.userId ?? null,
      expiresAt: new Date(p.expiresAt),
    };
    await this.prisma.oAuthPending.upsert({
      where: { id: p.id },
      create: { id: p.id, ...data },
      update: data,
    });
  }

  async getPending(id: string): Promise<PendingAuthorization | null> {
    const r = await this.prisma.oAuthPending.findUnique({ where: { id } });
    if (!r) return null;
    return {
      id: r.id,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      state: r.state ?? undefined,
      codeChallenge: r.codeChallenge,
      scope: r.scope ?? undefined,
      userId: r.userId ?? undefined,
      expiresAt: r.expiresAt.getTime(),
    };
  }

  async claimPending(id: string, userId: string, now: number): Promise<boolean> {
    const r = await this.prisma.oAuthPending.updateMany({
      where: { id, expiresAt: { gt: new Date(now) }, OR: [{ userId: null }, { userId }] },
      data: { userId },
    });
    return r.count === 1;
  }

  async takePending(id: string): Promise<PendingAuthorization | null> {
    const r = await this.prisma.oAuthPending.delete({ where: { id } }).catch(() => null);
    if (!r) return null;
    return {
      id: r.id,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      state: r.state ?? undefined,
      codeChallenge: r.codeChallenge,
      scope: r.scope ?? undefined,
      userId: r.userId ?? undefined,
      expiresAt: r.expiresAt.getTime(),
    };
  }

  async deletePending(id: string): Promise<void> {
    await this.prisma.oAuthPending.deleteMany({ where: { id } });
  }

  async saveCode(c: AuthCode): Promise<void> {
    await this.prisma.oAuthCode.create({
      data: {
        codeHash: sha256Base64Url(c.code),
        clientId: c.clientId,
        redirectUri: c.redirectUri,
        userId: c.userId,
        codeChallenge: c.codeChallenge,
        scope: c.scope ?? null,
        expiresAt: new Date(c.expiresAt),
      },
    });
  }

  /** Uso único: o `delete` é atômico, então duas trocas simultâneas do mesmo code não passam as duas. */
  async takeCode(code: string): Promise<AuthCode | null> {
    const codeHash = sha256Base64Url(code);
    const r = await this.prisma.oAuthCode.delete({ where: { codeHash } }).catch(() => null);
    if (!r || r.expiresAt.getTime() <= Date.now()) return null;
    return {
      code,
      clientId: r.clientId,
      redirectUri: r.redirectUri,
      userId: r.userId,
      codeChallenge: r.codeChallenge,
      scope: r.scope ?? undefined,
      expiresAt: r.expiresAt.getTime(),
    };
  }

  async saveToken(t: TokenRecord): Promise<void> {
    await this.prisma.oAuthToken.create({
      data: {
        tokenHash: t.tokenHash,
        kind: t.kind,
        clientId: t.clientId,
        userId: t.userId,
        scope: t.scope ?? null,
        expiresAt: new Date(t.expiresAt),
      },
    });
  }

  async getToken(tokenHash: string): Promise<TokenRecord | null> {
    const r = await this.prisma.oAuthToken.findUnique({ where: { tokenHash } });
    if (!r || r.expiresAt.getTime() <= Date.now()) return null;
    return toTokenRecord(r);
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.prisma.oAuthToken.deleteMany({ where: { tokenHash } });
  }

  async listTokens(userId: string): Promise<TokenRecord[]> {
    const rows = await this.prisma.oAuthToken.findMany({ where: { userId, expiresAt: { gt: new Date() } } });
    return rows.map(toTokenRecord);
  }

  async deleteTokensOfClient(userId: string, clientId: string): Promise<void> {
    await this.prisma.oAuthToken.deleteMany({ where: { userId, clientId } });
  }

  async touchToken(tokenHash: string, lastUsedAt: number, expiresAt?: number): Promise<void> {
    await this.prisma.oAuthToken.updateMany({
      where: { tokenHash },
      data: { lastUsedAt: new Date(lastUsedAt), ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}) },
    });
  }
}

function toTokenRecord(r: {
  tokenHash: string;
  kind: string;
  clientId: string;
  userId: string;
  scope: string | null;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
}): TokenRecord {
  return {
    tokenHash: r.tokenHash,
    kind: r.kind === 'refresh' ? 'refresh' : r.kind === 'session' ? 'session' : 'access',
    clientId: r.clientId,
    userId: r.userId,
    scope: r.scope ?? undefined,
    expiresAt: r.expiresAt.getTime(),
    createdAt: r.createdAt.getTime(),
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt.getTime() } : {}),
  };
}

/** Usuários do login do OAuth: pelo e-mail (normalizado), criando se não existir. */
@Injectable()
export class PrismaUserDirectory implements UserDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateByEmail(email: string): Promise<{ id: string }> {
    const key = email.trim().toLowerCase();
    const user = await this.prisma.user.upsert({
      where: { email: key },
      create: { email: key },
      update: {},
      select: { id: true },
    });
    return { id: user.id };
  }

  async findProfile(userId: string): Promise<{ id: string; email: string | null; name: string | null } | null> {
    return this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } });
  }
}
