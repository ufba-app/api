import { Global, Module } from '@nestjs/common';
import { OAUTH_STORE, USER_DIRECTORY } from '../../application/oauth/oauth-ports';
import {
  ApiKeyRepository,
  SigaaCredentialRepository,
  SourceBindingRepository,
  SourceAccountRepository,
  UserRepository,
} from '../../application/ports/repositories';
import {
  PrismaApiKeyRepository,
  PrismaSigaaCredentialRepository,
  PrismaSourceBindingRepository,
  PrismaSourceAccountRepository,
  PrismaUserRepository,
} from './prisma-identity.repositories';
import { MemoryUserRepository } from '../../application/memory/memory-ports';
import { PrismaMemoryUserRepository } from './prisma-memory.repositories';
import { DeviceAuthorizationRepository, MemoryComputerRepository } from '../../application/memory/device-ports';
import { MemoryProjectRepository, MemorySyncJobRepository } from '../../application/memory/project-ports';
import { TeamRoleRepository, UserLister } from '../../application/memory/team-ports';
import { PrismaTeamRoleRepository, PrismaUserLister } from './prisma-team.repositories';
import { PrismaMemoryProjectRepository, PrismaMemorySyncJobRepository } from './prisma-project.repositories';
import { PrismaDeviceAuthorizationRepository, PrismaMemoryComputerRepository } from './prisma-device.repositories';
import { PrismaOAuthStore, PrismaUserDirectory } from './prisma-oauth.repositories';
import { PrismaService } from './prisma.service';

/** Só identidade, contas conectadas (token cifrado) e OAuth. Conteúdo das fontes não é gravado (leitura ao vivo). */
@Global()
@Module({
  providers: [
    PrismaService,
    { provide: UserRepository, useClass: PrismaUserRepository },
    { provide: ApiKeyRepository, useClass: PrismaApiKeyRepository },
    { provide: SourceAccountRepository, useClass: PrismaSourceAccountRepository },
    { provide: SigaaCredentialRepository, useClass: PrismaSigaaCredentialRepository },
    { provide: SourceBindingRepository, useClass: PrismaSourceBindingRepository },
    { provide: MemoryUserRepository, useClass: PrismaMemoryUserRepository },
    { provide: DeviceAuthorizationRepository, useClass: PrismaDeviceAuthorizationRepository },
    { provide: MemoryComputerRepository, useClass: PrismaMemoryComputerRepository },
    { provide: MemoryProjectRepository, useClass: PrismaMemoryProjectRepository },
    { provide: MemorySyncJobRepository, useClass: PrismaMemorySyncJobRepository },
    { provide: TeamRoleRepository, useClass: PrismaTeamRoleRepository },
    { provide: UserLister, useClass: PrismaUserLister },
    { provide: OAUTH_STORE, useClass: PrismaOAuthStore },
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
  ],
  exports: [
    UserRepository,
    ApiKeyRepository,
    SourceAccountRepository,
    SigaaCredentialRepository,
    SourceBindingRepository,
    MemoryUserRepository,
    DeviceAuthorizationRepository,
    MemoryComputerRepository,
    MemoryProjectRepository,
    MemorySyncJobRepository,
    TeamRoleRepository,
    UserLister,
    OAUTH_STORE,
    USER_DIRECTORY,
  ],
})
export class PersistenceModule {}
