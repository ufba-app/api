import { Controller, Get, Header, HttpCode, Param, Post, UseFilters, UseGuards, Module } from '@nestjs/common';
import { CalendarAlertService } from '../../application/calendar/calendar-alerts';
import { sessionExpired, type WebPrincipal } from '../../application/web/web-api';
import { ApiErrorFilter } from '../web/api-error.filter';
import { Principal, SessionGuard } from '../web/web-auth';

const must = (p: WebPrincipal | null): WebPrincipal => {
  if (!p) throw sessionExpired();
  return p;
};

/** Alertas do calendário acadêmico (só admin: o 403 `not_admin` vem do serviço). */
@Controller('admin/calendar')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class AdminCalendarController {
  constructor(private readonly alerts: CalendarAlertService) {}

  @Get('alerts')
  @Header('Cache-Control', 'no-store')
  async list(@Principal() p: WebPrincipal | null) {
    const a = await this.alerts.list(must(p).userId);
    return { items: a.items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })), expired: a.expired };
  }

  @Post('logs/:id/seen')
  @HttpCode(204)
  async seen(@Principal() p: WebPrincipal | null, @Param('id') id: string): Promise<void> {
    await this.alerts.markSeen(must(p).userId, id);
  }
}

/** As dependências (CalendarAlertService) vêm do módulo global da raiz de composição (`AppModule`). */
@Module({ controllers: [AdminCalendarController] })
export class CalendarModule {}
