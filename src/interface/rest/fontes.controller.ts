import { Controller, Get, UseGuards } from '@nestjs/common';
import { SourceRegistry } from '../../application/ports/source-gateway';
import { BearerGuard } from './auth.guard';

@Controller()
@UseGuards(BearerGuard)
export class FontesController {
  constructor(private readonly registry: SourceRegistry) {}

  /** Fontes disponíveis neste servidor e como cada uma autentica. */
  @Get('fontes')
  fontes(): Array<{ fonte: string; autenticacao: string }> {
    return this.registry.list().map((g) => ({ fonte: g.provider.toLowerCase(), autenticacao: g.auth }));
  }
}
