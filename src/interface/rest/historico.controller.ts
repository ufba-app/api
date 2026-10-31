import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { HistoricoService, type InsightTipo } from '../../application/academic/historico.service';
import { BearerGuard, CurrentUserId } from './auth.guard';
import { ApplicationErrorFilter } from './sincronizar.controller';

const TIPOS: readonly InsightTipo[] = ['cr', 'trajetoria', 'pendentes'];

/** Insights (só banco) e importação do histórico (SIGAA + IA). Mesmos casos de uso do MCP. */
@Controller()
@UseGuards(BearerGuard)
@UseFilters(ApplicationErrorFilter)
export class HistoricoController {
  constructor(private readonly historico: HistoricoService) {}

  @Get('insights')
  insights(@CurrentUserId() userId: string, @Query('tipo') tipo?: string) {
    if (!TIPOS.includes(tipo as InsightTipo)) {
      throw new BadRequestException(`tipo inválido; use: ${TIPOS.join(', ')}`);
    }
    return this.historico.insights(userId, tipo as InsightTipo);
  }

  /** Vai ao SIGAA com usuário/senha da requisição (usados em memória, nunca guardados nem logados). */
  @Post('historico/importar')
  importar(
    @CurrentUserId() userId: string,
    @Body() body: { usuario?: string; senha?: string } | undefined,
  ) {
    if (!body?.usuario || !body?.senha) {
      throw new BadRequestException('usuario e senha são obrigatórios');
    }
    return this.historico.importar({ userId, username: body.usuario, password: body.senha });
  }
}
