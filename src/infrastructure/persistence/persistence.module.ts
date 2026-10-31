import { Global, Module } from '@nestjs/common';
import {
  AttachmentLookup,
  TranscriptRepository,
} from '../../application/ports/academic-ports';
import { OAUTH_STORE, USER_DIRECTORY } from '../../application/oauth/oauth-ports';
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
import { PrismaAttachmentLookup, PrismaTranscriptRepository } from './prisma-academic.repositories';
import { PrismaOAuthStore, PrismaUserDirectory } from './prisma-oauth.repositories';
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
    { provide: TranscriptRepository, useClass: PrismaTranscriptRepository },
    { provide: AttachmentLookup, useClass: PrismaAttachmentLookup },
    { provide: OAUTH_STORE, useClass: PrismaOAuthStore },
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
  ],
  exports: [
    UserRepository,
    ApiKeyRepository,
    SourceAccountRepository,
    SyncRepository,
    ReadRepository,
    TranscriptRepository,
    AttachmentLookup,
    OAUTH_STORE,
    USER_DIRECTORY,
  ],
})
export class PersistenceModule {}
