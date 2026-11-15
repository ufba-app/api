import { Global, Module } from '@nestjs/common';
import { OAUTH_STORE, USER_DIRECTORY } from '../../application/oauth/oauth-ports';
import {
  ApiKeyRepository,
  SigaaCredentialRepository,
  SigaaSessionStore,
  SigaaMasterSlotRepository,
  SigaaPairingRepository,
  SigaaVaultRepository,
  SourceBindingRepository,
  SourceAccountRepository,
  StudentRegistrations,
  UserRepository,
} from '../../application/ports/repositories';
import {
  PrismaStudentRegistrations,
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
import { ProxyKeyStore } from '../../application/memory/proxy-key-rotation';
import { PrismaProxyKeyStore } from './prisma-proxy-key.store';
import { PrismaTeamRoleRepository, PrismaUserLister } from './prisma-team.repositories';
import { PrismaMemoryProjectRepository, PrismaMemorySyncJobRepository } from './prisma-project.repositories';
import { PrismaDeviceAuthorizationRepository, PrismaMemoryComputerRepository } from './prisma-device.repositories';
import { PrismaOAuthStore, PrismaUserDirectory } from './prisma-oauth.repositories';
import { PrismaSigaaSessionStore } from './prisma-sigaa-session.store';
import { PrismaSigaaMasterSlotRepository } from './prisma-sigaa-master-slot.repository';
import { PrismaSigaaPairingRepository } from './prisma-sigaa-pairing.repository';
import { PrismaSigaaVaultRepository } from './prisma-sigaa-vault.repository';
import { PrismaCatalogRepository } from './prisma-catalog.repository';
import { PrismaAcademicRepository } from './prisma-academic.repository';
import { AcademicRepository } from '../../application/ports/academic';
import { PrismaCalendarLogRepository } from './prisma-calendar-log.repository';
import { PrismaUserPermissionRepository } from './prisma-user-permission.repository';
import { UserPermissionRepository } from '../../application/ports/permissions';
import { SiasbCopyRepository } from '../../application/ports/siasb-copy';
import { PrismaSiasbCopyRepository } from './prisma-siasb-copy.repository';
import { CalendarLogRepository } from '../../application/ports/calendar';
import { CatalogRepository } from '../../application/ports/catalog';
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
    { provide: SigaaSessionStore, useClass: PrismaSigaaSessionStore },
    { provide: SigaaMasterSlotRepository, useClass: PrismaSigaaMasterSlotRepository },
    { provide: SigaaPairingRepository, useClass: PrismaSigaaPairingRepository },
    { provide: SigaaVaultRepository, useClass: PrismaSigaaVaultRepository },
    { provide: CatalogRepository, useClass: PrismaCatalogRepository },
    { provide: AcademicRepository, useClass: PrismaAcademicRepository },
    { provide: CalendarLogRepository, useClass: PrismaCalendarLogRepository },
    { provide: UserPermissionRepository, useClass: PrismaUserPermissionRepository },
    { provide: SiasbCopyRepository, useClass: PrismaSiasbCopyRepository },
    { provide: SourceBindingRepository, useClass: PrismaSourceBindingRepository },
    { provide: StudentRegistrations, useClass: PrismaStudentRegistrations },
    { provide: MemoryUserRepository, useClass: PrismaMemoryUserRepository },
    { provide: DeviceAuthorizationRepository, useClass: PrismaDeviceAuthorizationRepository },
    { provide: MemoryComputerRepository, useClass: PrismaMemoryComputerRepository },
    { provide: MemoryProjectRepository, useClass: PrismaMemoryProjectRepository },
    { provide: MemorySyncJobRepository, useClass: PrismaMemorySyncJobRepository },
    { provide: TeamRoleRepository, useClass: PrismaTeamRoleRepository },
    { provide: UserLister, useClass: PrismaUserLister },
    { provide: ProxyKeyStore, useClass: PrismaProxyKeyStore },
    { provide: OAUTH_STORE, useClass: PrismaOAuthStore },
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
  ],
  exports: [
    UserRepository,
    ApiKeyRepository,
    SourceAccountRepository,
    SigaaCredentialRepository,
    SigaaSessionStore,
    SigaaMasterSlotRepository,
    SigaaPairingRepository,
    SigaaVaultRepository,
    CatalogRepository,
    AcademicRepository,
    CalendarLogRepository,
    UserPermissionRepository,
    SiasbCopyRepository,
    SourceBindingRepository,
    StudentRegistrations,
    MemoryUserRepository,
    DeviceAuthorizationRepository,
    MemoryComputerRepository,
    MemoryProjectRepository,
    MemorySyncJobRepository,
    TeamRoleRepository,
    UserLister,
    ProxyKeyStore,
    OAUTH_STORE,
    USER_DIRECTORY,
  ],
})
export class PersistenceModule {}
