import { Injectable } from '@nestjs/common';
import {
  ApiKeyRecord,
  ApiKeyRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  UpsertSourceAccountInput,
  UserRecord,
  UserRepository,
} from '../../application/ports/repositories';
import type { Provider } from '../../application/ports/source-gateway';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaUserRepository extends UserRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  create(input: { name?: string }): Promise<UserRecord> {
    return this.prisma.user.create({ data: { name: input.name ?? null } });
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }
}

@Injectable()
export class PrismaApiKeyRepository extends ApiKeyRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(input: {
    userId: string;
    keyHash: string;
    prefix: string;
    label?: string;
  }): Promise<ApiKeyRecord> {
    const row = await this.prisma.apiKey.create({
      data: { ...input, label: input.label ?? null },
    });
    return { id: row.id, userId: row.userId };
  }

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findFirst({ where: { keyHash, revokedAt: null } });
    return row ? { id: row.id, userId: row.userId } : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
  }
}

type AccountRow = {
  id: string;
  userId: string;
  provider: Provider;
  accountKey: string;
  siteUrl: string | null;
  status: 'OK' | 'REAUTH_NEEDED' | 'BLOCKED';
  lastSyncedAt: Date | null;
  secretCiphertext: string | null;
  secretIv: string | null;
  secretAuthTag: string | null;
};

function toRecord(row: AccountRow): SourceAccountRecord {
  const secret =
    row.secretCiphertext && row.secretIv && row.secretAuthTag
      ? { ciphertext: row.secretCiphertext, iv: row.secretIv, authTag: row.secretAuthTag }
      : null;
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    accountKey: row.accountKey,
    siteUrl: row.siteUrl,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    secret,
  };
}

@Injectable()
export class PrismaSourceAccountRepository extends SourceAccountRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async upsert(input: UpsertSourceAccountInput): Promise<SourceAccountRecord> {
    const secret = input.secret
      ? {
          secretCiphertext: input.secret.ciphertext,
          secretIv: input.secret.iv,
          secretAuthTag: input.secret.authTag,
        }
      : {};
    const row = await this.prisma.sourceAccount.upsert({
      where: {
        userId_provider_accountKey: {
          userId: input.userId,
          provider: input.provider,
          accountKey: input.accountKey,
        },
      },
      create: {
        userId: input.userId,
        provider: input.provider,
        accountKey: input.accountKey,
        siteUrl: input.siteUrl ?? null,
        ...secret,
      },
      update: { siteUrl: input.siteUrl ?? undefined, status: 'OK', statusReason: null, ...secret },
    });
    return toRecord(row);
  }

  async findByUserAndProvider(userId: string, provider: Provider): Promise<SourceAccountRecord[]> {
    const rows = await this.prisma.sourceAccount.findMany({ where: { userId, provider } });
    return rows.map(toRecord);
  }

  async listByUser(userId: string): Promise<SourceAccountRecord[]> {
    const rows = await this.prisma.sourceAccount.findMany({ where: { userId } });
    return rows.map(toRecord);
  }

  async setStatus(
    id: string,
    status: SourceAccountRecord['status'],
    reason?: string,
  ): Promise<void> {
    await this.prisma.sourceAccount.update({
      where: { id },
      data: { status, statusReason: reason ?? null },
    });
  }
}
