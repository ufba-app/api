import { AcademicCalendar } from '../ports/academic-calendar';
import { CalendarLogRepository } from '../ports/calendar';

const DAY_MS = 86_400_000;
const BAHIA_OFFSET_MS = 3 * 3_600_000;
const CACHE_MS = 60_000;

interface Term {
  start: string;
  end: string;
  off: Array<{ start: string; end: string }>;
}

/** Dia da Bahia (UTC-3 fixo) como `YYYY-MM-DD`. */
const bahiaIso = (d: Date) => new Date(d.getTime() - BAHIA_OFFSET_MS).toISOString().slice(0, 10);
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Feriados e recessos do calendário acadêmico publicado pela SUPAC (os semestres PUBLISHED e verificados).
 * `known: true` só quando todos os dias do intervalo caem dentro de algum semestre publicado; fora disso o prazo
 * mantém a margem de segurança. Nunca lança por falta de dado: sem calendário ou com erro no banco, `known: false`.
 */
export class PublishedAcademicCalendar extends AcademicCalendar {
  private cache: { at: number; terms: Term[] } | null = null;

  constructor(
    private readonly logs: CalendarLogRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async holidays(from: Date, to: Date): Promise<{ known: boolean; dates: string[] }> {
    const none = { known: false, dates: [] as string[] };
    const a = dayNumber(bahiaIso(from));
    const b = dayNumber(bahiaIso(to));
    if (!(a <= b)) return none;
    let terms: Term[];
    try {
      terms = await this.load();
    } catch {
      return none;
    }
    if (terms.length === 0) return none;

    const dates = new Set<string>();
    for (const t of terms) {
      for (const r of t.off) {
        const lo = Math.max(a, dayNumber(r.start));
        const hi = Math.min(b, dayNumber(r.end));
        for (let n = lo; n <= hi; n++) dates.add(isoOf(n));
      }
    }

    // Cobertura: percorre os semestres por início e avança o primeiro dia ainda sem cobertura.
    let next = a;
    for (const t of [...terms].sort((x, y) => x.start.localeCompare(y.start))) {
      if (dayNumber(t.start) > next) break;
      next = Math.max(next, dayNumber(t.end) + 1);
      if (next > b) break;
    }
    return { known: next > b, dates: [...dates].sort() };
  }

  private async load(): Promise<Term[]> {
    const nowMs = this.now().getTime();
    if (this.cache && nowMs - this.cache.at < CACHE_MS) return this.cache.terms;
    const latest = new Map<string, { createdAt: number; term: Term }>();
    for (const r of await this.logs.listPublished()) {
      if (!r.contract || !r.term) continue;
      const created = r.createdAt.getTime();
      if ((latest.get(r.term)?.createdAt ?? -Infinity) >= created) continue;
      latest.set(r.term, {
        createdAt: created,
        term: {
          start: r.contract.keyDates.termStart,
          end: r.contract.keyDates.termEnd,
          off: r.contract.nonTeachingDays.map((n) =>
            n.when.type === 'on' ? { start: n.when.date, end: n.when.date } : { start: n.when.start, end: n.when.end },
          ),
        },
      });
    }
    const terms = [...latest.values()].map((v) => v.term);
    this.cache = { at: nowMs, terms };
    return terms;
  }
}
