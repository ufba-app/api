import { Module, Type } from '@nestjs/common';
import { IdentityService } from './application/identity/identity.service';
import { AUTHENTICATORS } from './application/ports/authenticator';
import { SecretCipher } from './application/ports/secret-cipher';
import {
  SourceGateway,
  SourceRegistry,
} from './application/ports/source-gateway';
import { LeituraService } from './application/read/leitura.service';
import { SincronizarService } from './application/sync/sincronizar.service';
import { AesSecretCipher } from './infrastructure/crypto/aes-secret-cipher';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { BearerGuard } from './interface/rest/auth.guard';
import { HealthController } from './interface/rest/health.controller';
import { LeituraController } from './interface/rest/leitura.controller';
import { SincronizarController } from './interface/rest/sincronizar.controller';
import { UsuariosController } from './interface/rest/usuarios.controller';

/**
 * Fontes registradas. Cada fonte entra aqui com a classe do seu gateway (injetável, implementa `SourceGateway`):
 *   SigaaGateway, MoodleGateway, ClassroomGateway, CalendarGateway
 * O registry as junta; `POST /sincronizar` e `GET /fontes` só enxergam o que estiver registrado.
 */
const SOURCE_GATEWAYS: Type<SourceGateway>[] = [];

@Module({
  imports: [PersistenceModule],
  controllers: [
    HealthController,
    UsuariosController,
    SincronizarController,
    LeituraController,
  ],
  providers: [
    IdentityService,
    SincronizarService,
    LeituraService,
    BearerGuard,
    { provide: SecretCipher, useFactory: () => new AesSecretCipher() },
    ...SOURCE_GATEWAYS,
    {
      provide: SourceRegistry,
      useFactory: (...gateways: SourceGateway[]) => {
        const registry = new SourceRegistry();
        gateways.forEach((g) => registry.register(g));
        return registry;
      },
      inject: SOURCE_GATEWAYS,
    },
    // Autenticadores do Bearer: chave de API estática hoje; o OAuth do serviço (Ponte) acrescenta o seu aqui.
    {
      provide: AUTHENTICATORS,
      useFactory: (identity: IdentityService) => [identity],
      inject: [IdentityService],
    },
  ],
  exports: [
    IdentityService,
    SourceRegistry,
    LeituraService,
    SincronizarService,
  ],
})
export class AppModule {}
