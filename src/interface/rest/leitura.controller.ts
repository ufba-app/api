import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LeituraService } from '../../application/read/leitura.service';
import { ItemKind } from '../../application/ports/source-gateway';
import { BearerGuard, CurrentUserId } from './auth.guard';
import { parseProvider } from './sincronizar.controller';

const KINDS: Record<string, ItemKind> = {
  aviso: 'ANNOUNCEMENT',
  tarefa: 'ASSIGNMENT',
  prova: 'ASSESSMENT',
  material: 'MATERIAL',
  forum: 'FORUM_TOPIC',
  outro: 'OTHER',
};

function date(value: string | undefined, name: string, fallback?: Date): Date {
  if (value === undefined || value === '') {
    if (fallback) return fallback;
    throw new BadRequestException(`${name} é obrigatório (ISO 8601)`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} inválido (ISO 8601)`);
  return d;
}

function limit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('limite inválido');
  return n;
}

/** Leituras: só banco, sempre com `atualizadoEm`. Para dado novo, o chamador usa POST /sincronizar. */
@Controller()
@UseGuards(BearerGuard)
export class LeituraController {
  constructor(private readonly leitura: LeituraService) {}

  @Get('cursos')
  cursos(@CurrentUserId() userId: string) {
    return this.leitura.listarCursos(userId);
  }

  @Get('itens')
  itens(
    @CurrentUserId() userId: string,
    @Query('fonte') fonte?: string,
    @Query('curso') curso?: string,
    @Query('tipo') tipo?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('limite') limite?: string,
  ) {
    const kind = tipo ? KINDS[tipo.toLowerCase()] : undefined;
    if (tipo && !kind) {
      throw new BadRequestException(`tipo inválido; use: ${Object.keys(KINDS).join(', ')}`);
    }
    return this.leitura.listarItens({
      userId,
      provider: fonte ? parseProvider(fonte) : undefined,
      courseSpaceId: curso,
      kind,
      dueFrom: de ? date(de, 'de') : undefined,
      dueTo: ate ? date(ate, 'ate') : undefined,
      limit: limit(limite),
    });
  }

  /** Prazos e eventos entre `de` (padrão: agora) e `ate` (padrão: +14 dias). */
  @Get('agenda')
  agenda(
    @CurrentUserId() userId: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    const from = date(de, 'de', new Date());
    const to = date(ate, 'ate', new Date(from.getTime() + 14 * 86_400_000));
    return this.leitura.agenda({ userId, de: from, ate: to });
  }

  /** O que mudou desde `desde` (obrigatório). */
  @Get('mudancas')
  mudancas(
    @CurrentUserId() userId: string,
    @Query('desde') desde?: string,
    @Query('limite') limite?: string,
  ) {
    return this.leitura.mudancas({
      userId,
      desde: date(desde, 'desde'),
      limite: limit(limite),
    });
  }

  @Get('perfil')
  perfil(@CurrentUserId() userId: string) {
    return this.leitura.perfil(userId);
  }

  @Get('historico')
  historico(@CurrentUserId() userId: string) {
    return this.leitura.historico(userId);
  }
}
