import { CalendarLogRepository, type CalendarLogRow } from '../ports/calendar';
import { ApiError } from '../web/web-api';

/** Quem é admin (a mesma lista `ADMIN_EMAILS` da memória). Só o que o alerta precisa. */
export interface CalendarAdminGate {
  require(userId: string): Promise<void>;
}

/** O que o "Reprocessar" precisa do verificador. */
export interface CalendarReprocessor {
  startReprocess(id: string): Promise<void>;
}

export interface CalendarAlertItem {
  id: string;
  createdAt: Date;
  sourceUrl: string;
  term: string | null;
  status: 'NOT_VERIFIED' | 'ERROR';
  warnings: string[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CalendarAlerts {
  items: CalendarAlertItem[];
  /** Último calendário publicado já terminou e nada novo apareceu. */
  expired: { term: string; termEnd: string } | null;
}

/** Hoje em Salvador (America/Bahia, UTC-3 o ano todo desde 2019), como AAAA-MM-DD. */
export function todayInBahia(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

interface PublishedSpan {
  term: string;
  termStart: string;
  termEnd: string;
}

const spanOf = (row: CalendarLogRow): PublishedSpan | null => {
  const k = row.contract?.keyDates;
  return row.term && k ? { term: row.term, termStart: k.termStart, termEnd: k.termEnd } : null;
};

/**
 * Semestre vigente: o do calendário publicado cujo período contém hoje; se hoje cai entre dois semestres, o próximo a
 * começar; se todos já terminaram, o mais recente. `null` sem nenhum calendário publicado.
 */
export function currentTerm(published: PublishedSpan[], today: string): string | null {
  if (published.length === 0) return null;
  const inside = published.filter((p) => p.termStart <= today && today <= p.termEnd).sort((a, b) => b.term.localeCompare(a.term));
  if (inside[0]) return inside[0].term;
  const next = published.filter((p) => p.termStart > today).sort((a, b) => a.termStart.localeCompare(b.termStart));
  if (next[0]) return next[0].term;
  return [...published].sort((a, b) => b.term.localeCompare(a.term))[0]!.term;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Alertas do calendário para o painel dos admins e o "Visto". */
export class CalendarAlertService {
  constructor(
    private readonly logs: CalendarLogRepository,
    private readonly admins: CalendarAdminGate,
    private readonly now: () => Date = () => new Date(),
    private readonly reprocessor: CalendarReprocessor | null = null,
  ) {}

  /**
   * Alerta = não é PUBLISHED, não foi visto e (é ERROR, ou o semestre é o vigente ou futuro). ERROR sem semestre (a página
   * toda falhou) alerta sempre. Sem calendário publicado, tudo que não é PUBLISHED alerta.
   */
  async list(userId: string): Promise<CalendarAlerts> {
    await this.admins.require(userId);
    const [problems, published] = await Promise.all([this.logs.listUnseenProblems(), this.logs.listPublished()]);
    const spans = published.map(spanOf).filter((s): s is PublishedSpan => s !== null);
    const today = todayInBahia(this.now());
    const current = currentTerm(spans, today);

    const items = problems
      .filter((r) => {
        if (r.status === 'ERROR' && r.term === null) return true;
        if (current === null) return true;
        return r.term !== null && r.term >= current;
      })
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        sourceUrl: r.sourceUrl,
        term: r.term,
        status: r.status as 'NOT_VERIFIED' | 'ERROR',
        warnings: r.warnings,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const latest = [...spans].sort((a, b) => b.term.localeCompare(a.term))[0];
    const expired = latest && latest.termEnd < today ? { term: latest.term, termEnd: latest.termEnd } : null;
    return { items, expired };
  }

  /** "Reprocessar": só admin; valida e dispara a releitura em segundo plano (a tela acompanha pelos alertas). */
  async reprocess(userId: string, id: string): Promise<void> {
    await this.admins.require(userId);
    if (!this.reprocessor) throw new ApiError(503, 'calendar_unavailable', 'A leitura do calendário está indisponível neste servidor.');
    if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Registro não encontrado.');
    await this.reprocessor.startReprocess(id);
  }

  async markSeen(userId: string, id: string): Promise<void> {
    await this.admins.require(userId);
    if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Registro não encontrado.');
    const row = await this.logs.markSeen(id, userId, this.now());
    if (!row) throw new ApiError(404, 'not_found', 'Registro não encontrado.');
  }
}
