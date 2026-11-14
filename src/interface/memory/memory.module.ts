import { Module } from '@nestjs/common';
import { DeviceTokenGuard } from './device-token.guard';
import { MemoryAdminController, MemoryInstallerController, MemoryWebController } from './memory.controllers';

/**
 * Rotas de memória (web e instalador). As dependências (MemoryWeb, MemoryComputers, DeviceAuthorizations,
 * InstallManifests) vêm do módulo global da raiz de composição (`AppModule`).
 */
@Module({ controllers: [MemoryWebController, MemoryAdminController, MemoryInstallerController], providers: [DeviceTokenGuard] })
export class MemoryModule {}
