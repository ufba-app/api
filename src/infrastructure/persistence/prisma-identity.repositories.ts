import { Injectable } from '@nestjs/common';
import {
  ApiKeyRecord,
  ApiKeyRepository,
  EncryptedSecret,
  SigaaCredentialRecord,
  SigaaCredentialRepository,
  SourceBindingRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  UpsertSourceAccountInput,
  UserRecord,
  UserRepository,
} from '../../application/ports/repositories';
import type { Provider } from '../../application/ports/source-gateway';
import type { BoundSource } from '../../domain/identity/source-binding';
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

  async delete(id: string): Promise<void> {
    await this.prisma.sourceAccount.deleteMany({ where: { id } });
  }
}

type SigaaCredentialRow = {
  id: string;
  userId: string;
  clientId: string;
  login: string;
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  status: 'OK' | 'REAUTH_NEEDED' | 'BLOCKED';
  createdAt: Date;
};

function toCredentialRecord(row: SigaaCredentialRow): SigaaCredentialRecord {
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    login: row.login,
    secret: { ciphertext: row.secretCiphertext, iv: row.secretIv, authTag: row.secretAuthTag },
    status: row.status === 'OK' ? 'OK' : 'REAUTH_NEEDED',
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaSigaaCredentialRepository extends SigaaCredentialRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async upsert(input: {
    userId: string;
    clientId: string;
    login: string;
    secret: EncryptedSecret;
  }): Promise<SigaaCredentialRecord> {
    const cols = {
      login: input.login,
      secretCiphertext: input.secret.ciphertext,
      secretIv: input.secret.iv,
      secretAuthTag: input.secret.authTag,
    };
    const row = await this.prisma.sigaaCredential.upsert({
      where: { userId_clientId: { userId: input.userId, clientId: input.clientId } },
      create: { userId: input.userId, clientId: input.clientId, ...cols },
      update: { ...cols, status: 'OK' },
    });
    return toCredentialRecord(row);
  }

  async find(userId: string, clientId: string): Promise<SigaaCredentialRecord | null> {
    const row = await this.prisma.sigaaCredential.findUnique({
      where: { userId_clientId: { userId, clientId } },
    });
    return row ? toCredentialRecord(row) : null;
  }

  async setStatus(id: string, status: 'OK' | 'REAUTH_NEEDED'): Promise<void> {
    await this.prisma.sigaaCredential.update({ where: { id }, data: { status } });
  }

  async delete(userId: string, clientId: string): Promise<void> {
    await this.prisma.sigaaCredential.deleteMany({ where: { userId, clientId } });
  }
}

@Injectable()
export class PrismaSourceBindingRepository extends SourceBindingRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findMine(userId: string, source: BoundSource): Promise<string | null> {
    const r = await this.prisma.sourceBinding.findUnique({
      where: { userId_provider: { userId, provider: source } },
      select: { subjectHash: true },
    });
    return r?.subjectHash ?? null;
  }

  async findOwner(source: BoundSource, subjectHash: string): Promise<string | null> {
    const r = await this.prisma.sourceBinding.findUnique({
      where: { provider_subjectHash: { provider: source, subjectHash } },
      select: { userId: true },
    });
    return r?.userId ?? null;
  }

  async create(userId: string, source: BoundSource, subjectHash: string): Promise<boolean> {
    try {
      await this.prisma.sourceBinding.create({ data: { userId, provider: source, subjectHash } });
      return true;
    } catch (e) {
      // P2002: unicidade (outro vínculo chegou antes). Quem chama relê e decide.
      if ((e as { code?: string })?.code === 'P2002') return false;
      throw e;
    }
  }
}
