import { Module } from '@nestjs/common';
import { DataController } from './data.controller';
import { SigaaLaunchController } from './sigaa-launch.controller';
import { OpenApiController } from './openapi.controller';
import {
  AuthorizedAppsController,
  AuthorizeRequestsController,
  ClientLogosController,
  AcademicController,
  SiasbController,
  PermissionsController,
  PushConfigController,
  PushDevicesController,
  NotificationSettingsController,
  ConnectionsController,
  PairingsController,
  SessionController,
  SigaaPasskeyController,
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
    SigaaLaunchController,
    AcademicController,
    SiasbController,
    PermissionsController,
    PushConfigController,
    PushDevicesController,
    NotificationSettingsController,
    SigaaPasskeyController,
    PairingsController,
    AuthorizeRequestsController,
    AuthorizedAppsController,
    ClientLogosController,
    DataController,
    OpenApiController,
  ],
  providers: [SessionGuard, OptionalSessionGuard, DataGuard],
})
export class WebModule {}
