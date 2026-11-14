import { Controller, Get, Header } from '@nestjs/common';
import { openApiJson } from './openapi';

/** Contrato da API (gerado dos schemas Zod). O web gera tipos e Zod a partir dele. */
@Controller()
export class OpenApiController {
  private readonly json = openApiJson();

  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  spec(): string {
    return this.json;
  }
}
