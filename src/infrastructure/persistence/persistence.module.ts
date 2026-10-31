import { Global, Module } from '@nestjs/common';
import {
  ApiKeyRepository,
  ReadRepository,
  SourceAccountRepository,
  SyncRepository,
  UserRepository,
} from '../../application/ports/repositories';
import {
  PrismaApiKeyRepository,
  PrismaSourceAccountRepository,
  PrismaUserRepository,
} from './prisma-identity.repositories';
import { PrismaReadRepository } from './prisma-read.repository';
import { PrismaSyncRepository } from './prisma-sync.repository';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    PrismaService,
    { provide: UserRepository, useClass: PrismaUserRepository },
    { provide: ApiKeyRepository, useClass: PrismaApiKeyRepository },
    { provide: SourceAccountRepository, useClass: PrismaSourceAccountRepository },
    { provide: SyncRepository, useClass: PrismaSyncRepository },
    { provide: ReadRepository, useClass: PrismaReadRepository },
  ],
  exports: [
    UserRepository,
    ApiKeyRepository,
    SourceAccountRepository,
    SyncRepository,
    ReadRepository,
  ],
})
export class PersistenceModule {}
