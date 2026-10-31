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

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const r = await this.prisma.oAuthClient.findUnique({ where: { clientId } });
    return r
      ? {
          clientId: r.clientId,
          clientName: r.clientName ?? undefined,
          redirectUris: r.redirectUris,
          createdAt: r.createdAt.getTime(),
        }
      : null;
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
    if (!r || r.expiresAt.getTime() <= Date.now()) return null;
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
    return {
      tokenHash: r.tokenHash,
      kind: r.kind === 'refresh' ? 'refresh' : 'access',
      clientId: r.clientId,
      userId: r.userId,
      scope: r.scope ?? undefined,
      expiresAt: r.expiresAt.getTime(),
    };
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.prisma.oAuthToken.deleteMany({ where: { tokenHash } });
  }
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
}
