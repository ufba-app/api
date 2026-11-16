import { CalendarLogRepository } from '../ports/calendar';
import { ApiError } from '../web/web-api';
import type { CalendarContract } from './contract';
import { currentTerm, todayInBahia } from './calendar-alerts';

/** O calendário publicado como o app o lê: o contrato fiel ao PDF, sem a conferência interna (`verification`). */
export type PublishedCalendarView = Omit<CalendarContract, 'verification'> & { sourceUrl: string; publishedAt: Date };

/**
 * Entrega ao app o calendário PUBLISHED de um semestre. Sem `term`, o semestre vigente (o que contém hoje; entre dois
 * semestres, o próximo a começar; passados todos, o mais recente). Reedição do mesmo semestre: vale a mais recente.
 */
export class PublishedCalendar {
  constructor(
    private readonly logs: CalendarLogRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Todos os calendários publicados (o mais recente de cada semestre), para quem precisa de mais de um (ex.: o calendário do painel). */
  async all(): Promise<PublishedCalendarView[]> {
    return (await this.logs.listPublished())
      .filter((r) => r.contract && r.term)
      .map((r) => {
        const { verification: _verification, ...contract } = r.contract!;
        return { ...contract, sourceUrl: r.sourceUrl, publishedAt: r.createdAt };
      });
  }

  async get(term?: string): Promise<PublishedCalendarView> {
    const published = (await this.logs.listPublished()).filter((r) => r.contract && r.term);
    const wanted =
      term ??
      currentTerm(
        published.map((r) => ({ term: r.term!, termStart: r.contract!.keyDates.termStart, termEnd: r.contract!.keyDates.termEnd })),
        todayInBahia(this.now()),
      );
    const row = published.find((r) => r.term === wanted);
    if (!row || !row.contract) throw new ApiError(404, 'not_found', 'Não há calendário publicado para este semestre.');
    const { verification: _verification, ...contract } = row.contract;
    return { ...contract, sourceUrl: row.sourceUrl, publishedAt: row.createdAt };
  }
}
