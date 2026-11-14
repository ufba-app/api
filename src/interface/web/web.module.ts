import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { OpenApiController } from './openapi.controller';
import {
  AuthorizedAppsController,
  AuthorizeRequestsController,
  ClientLogosController,
  ConnectionsController,
  SessionController,
} from './web.controllers';
import { DataGuard, OptionalSessionGuard, SessionGuard } from './web-auth';

/**
 * API do app web (docs/WEB-API.md). As dependências (casos de uso de application/web, OAUTH_SERVICE, CLIENT_DIRECTORY, ConsultaService,
 * AUTHENTICATORS) vêm do módulo global da raiz de composição.
 */
@Module({
  controllers: [
    SessionController,
    ConnectionsController,
    AuthorizeRequestsController,
    AuthorizedAppsController,
    ClientLogosController,
    DataController,
    OpenApiController,
  ],
  providers: [SessionGuard, OptionalSessionGuard, DataGuard],
})
export class WebModule {}
