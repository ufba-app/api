import { todayInBahia } from '../calendar/calendar-alerts';
import type { PublishedCalendarView } from '../calendar/published-calendar';
import { isMarked } from '../../domain/siasb/clinical-state';
import { FonteNaoConectadaError, type ContaConectada, type Quem } from '../live/consulta.service';
import type { PrazoVivo } from '../ports/live-source';
import { ApiError } from './web-api';

export type CalendarSourceName = 'sigaa' | 'moodle' | 'classroom' | 'siasb';
export type CalendarSourceStatus = 'ok' | 'failed' | 'reconnect_required';
export type CalendarItemKind = 'class' | 'deadline' | 'exam' | 'session';

export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  source: CalendarSourceName;
  title: string;
  courseName: string | null;
  courseCode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  place: string | null;
}

export interface MeCalendarView {
  from: string;
  to: string;
  term: string | null;
  days: Array<{ date: string; nonTeaching: { name: string } | null; items: CalendarItem[] }>;
  sources: Array<{ source: CalendarSourceName; status: CalendarSourceStatus }>;
}

/** O que o serviço precisa de cada coisa (portas estreitas: os testes passam fakes, sem rede nem banco). */
export interface MeCalendarDeps {
  calendars: { all(): Promise<PublishedCalendarView[]> };
  consulta: {
    contas(q: Quem): Promise<ContaConectada[]>;
    prazos(q: Quem, provider: 'MOODLE' | 'CLASSROOM', conta?: string): Promise<PrazoVivo[]>;
  };
  siasb: {
    /** Conexão com o SIASB e se ele é oferecido à pessoa. */
    status(userId: string): Promise<{ offered: boolean; status: 'connected' | 'reconnect_required' | 'disconnected' }>;
    agenda(
      userId: string,
      from: Date,
      to: Date,
    ): Promise<{ stale: boolean; items: Array<{ id: string; disciplineName: string; locationName: string; startAt: Date; endAt: Date; statusLabel: string }> }>;
  };
  now?: () => Date;
}

export const MAX_RANGE_DAYS = 62;
const CACHE_TTL_MS = 3 * 60_000;
const CACHE_MAX = 500;
const SOURCE_TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;
const BAHIA_OFFSET_MS = 3 * 3_600_000; // America/Bahia: UTC-3 o ano todo desde 2019

const invalid = () => new ApiError(400, 'invalid_request', 'Informe `from` e `to` (AAAA-MM-DD), com no máximo 62 dias.');

function parseDay(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t;
}

const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Instante → ISO com o fuso de Salvador (`2026-11-18T09:00:00-03:00`). */
export function bahiaIso(d: Date): string {
  return `${new Date(d.getTime() - BAHIA_OFFSET_MS).toISOString().slice(0, 19)}-03:00`;
}

/** Instante → dia (AAAA-MM-DD) em Salvador. */
export const bahiaDay = (d: Date): string => todayInBahia(d);

const EXAM = /\b(prova|exame|teste|avalia[cç][aã]o)\b/i;

/**
 * A API classifica (o web não adivinha): `prova` do Moodle (módulo quiz) ou título de prova/exame/teste/avaliação = `exam`;
 * o resto é `deadline` (entrega).
 */
export function classifyDeadline(p: Pick<PrazoVivo, 'tipo' | 'titulo'>): 'deadline' | 'exam' {
  if (p.tipo === 'prova' || p.tipo === 'quiz') return 'exam';
  return EXAM.test(p.titulo) ? 'exam' : 'deadline';
}

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), SOURCE_TIMEOUT_MS).unref())]);

/**
 * `GET /me/calendar`: compila o que a pessoa tem em cada dia num formato pronto para desenhar. Feriados e dias sem aula vêm do
 * calendário acadêmico (intervalos já expandidos); entregas e provas do Moodle e do Classroom (ao vivo, uma consulta por conta,
 * em paralelo, com teto de tempo); sessões da clínica do SIASB da cópia sincronizada (sem dado de paciente, não excluídas em
 * feriado, só para quem tem acesso). Falha de uma fonte não derruba a rota: ela vira `sources[].status`. As aulas (`class`)
 * entram quando as turmas do SIGAA com dia e horário existirem; o formato não muda.
 */
export class MeCalendar {
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; value: MeCalendarView }>();

  constructor(private readonly d: MeCalendarDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async get(q: Quem, from: string, to: string): Promise<MeCalendarView> {
    const a = parseDay(from);
    const b = parseDay(to);
    if (a === null || b === null || b < a || (b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) throw invalid();

    const key = `${q.userId}|${from}|${to}`;
    const hit = this.cache.get(key);
    if (hit && this.now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;

    const [calendar, prazos, siasb] = await Promise.all([this.holidays(from, to, a, b), this.deadlines(q, from, to), this.sessions(q.userId, a, b)]);
    const days = new Map<string, { date: string; nonTeaching: { name: string } | null; items: CalendarItem[] }>();
    const day = (date: string) => {
      let r = days.get(date);
      if (!r) days.set(date, (r = { date, nonTeaching: null, items: [] }));
      return r;
    };
    for (const [date, name] of calendar.nonTeaching) day(date).nonTeaching = { name };
    for (const it of [...prazos.items, ...siasb.items]) {
      const when = it.startsAt ?? it.endsAt;
      if (!when) continue;
      const date = when.slice(0, 10); // já está no fuso de Salvador
      if (date >= from && date <= to) day(date).items.push(it);
    }
    const order = (it: CalendarItem) => it.startsAt ?? it.endsAt ?? '';
    const value: MeCalendarView = {
      from,
      to,
      term: calendar.term,
      days: [...days.values()]
        .sort((x, y) => x.date.localeCompare(y.date))
        .map((r) => ({ ...r, items: r.items.sort((x, y) => order(x).localeCompare(order(y)) || x.title.localeCompare(y.title)) })),
      sources: [...prazos.sources, ...siasb.sources],
    };
    // Falha parcial não fica em cache: a pessoa reconecta ou tenta de novo e vê o resultado novo.
    if (value.sources.every((s) => s.status === 'ok')) this.remember(key, value);
    return value;
  }

  private remember(key: string, value: MeCalendarView): void {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: this.now().getTime(), value });
  }

  /** Dias sem aula do intervalo (de TODOS os calendários publicados) e o semestre que mais cobre o intervalo. */
  private async holidays(from: string, to: string, a: number, b: number) {
    const nonTeaching = new Map<string, string>();
    let term: string | null = null;
    let best = 0;
    for (const c of await this.d.calendars.all()) {
      const start = parseDay(c.keyDates.termStart);
      const end = parseDay(c.keyDates.termEnd);
      if (start !== null && end !== null) {
        const overlap = Math.min(end, b) - Math.max(start, a);
        if (overlap >= 0 && overlap >= best) {
          best = overlap;
          term = c.document.term;
        }
      }
      for (const n of c.nonTeachingDays) {
        const s = parseDay(n.when.type === 'on' ? n.when.date : n.when.start);
        const e = parseDay(n.when.type === 'on' ? n.when.date : n.when.end);
        if (s === null || e === null) continue;
        for (let t = Math.max(s, a); t <= Math.min(e, b); t += DAY_MS) {
          const date = dayStr(t);
          const cur = nonTeaching.get(date);
          if (!cur) nonTeaching.set(date, n.name);
          else if (!cur.split(' · ').includes(n.name)) nonTeaching.set(date, `${cur} · ${n.name}`);
        }
      }
    }
    return { term, nonTeaching };
  }

  /** Entregas e provas do Moodle e do Classroom: uma consulta por conta, em paralelo; o status é por fonte. */
  private async deadlines(q: Quem, from: string, to: string) {
    const contas = (await this.d.consulta.contas(q)).filter(
      (c): c is ContaConectada & { provider: 'MOODLE' | 'CLASSROOM' } => c.provider === 'MOODLE' || c.provider === 'CLASSROOM',
    );
    const items: CalendarItem[] = [];
    const flags = new Map<CalendarSourceName, { failed: boolean; reconnect: boolean }>();
    await Promise.all(
      contas.map(async (c) => {
        const source = c.provider === 'MOODLE' ? 'moodle' : 'classroom';
        const f = flags.get(source) ?? { failed: false, reconnect: false };
        flags.set(source, f);
        if (c.status === 'REAUTH_NEEDED') {
          f.reconnect = true;
          return;
        }
        try {
          for (const p of await withTimeout(this.d.consulta.prazos(q, c.provider, c.conta))) {
            const kind = classifyDeadline(p);
            items.push({
              id: `${source}:${c.conta}:${p.id}`,
              kind,
              source,
              title: p.titulo,
              courseName: p.cursoNome ?? null,
              courseCode: null,
              // Prova: o horário que a fonte dá é o início; entrega: o horário é o PRAZO (fim).
              startsAt: kind === 'exam' ? bahiaIso(p.quando) : null,
              endsAt: kind === 'deadline' ? bahiaIso(p.quando) : null,
              place: c.provider === 'MOODLE' ? 'Moodle' : 'Classroom',
            });
          }
        } catch (e) {
          if (e instanceof FonteNaoConectadaError) f.reconnect = true;
          else f.failed = true;
        }
      }),
    );
    const sources = [...flags].map(([source, f]) => ({
      source,
      status: (f.reconnect ? 'reconnect_required' : f.failed ? 'failed' : 'ok') as CalendarSourceStatus,
    }));
    return { items, sources };
  }

  /** Sessões marcadas na clínica, só para quem tem acesso e conexão com o SIASB; sem nome de paciente. */
  private async sessions(userId: string, a: number, b: number) {
    const none = { items: [] as CalendarItem[], sources: [] as MeCalendarView['sources'] };
    let st;
    try {
      st = await this.d.siasb.status(userId);
    } catch {
      return none;
    }
    // Sem acesso ou sem conexão: nenhum item e o `siasb` nem entra em `sources`.
    if (st.status === 'disconnected') return none;
    try {
      // Janela em instantes: do começo do primeiro dia ao fim do último, em Salvador.
      const r = await this.d.siasb.agenda(userId, new Date(a + BAHIA_OFFSET_MS), new Date(b + DAY_MS + BAHIA_OFFSET_MS - 1));
      const items = r.items
        .filter((s) => isMarked(s.statusLabel))
        .map<CalendarItem>((s) => ({
          id: `siasb:${s.id}`,
          kind: 'session',
          source: 'siasb',
          title: 'Sessão na clínica',
          courseName: s.disciplineName || null,
          courseCode: null,
          startsAt: bahiaIso(s.startAt),
          endsAt: bahiaIso(s.endAt),
          place: s.locationName || null,
        }));
      const status: CalendarSourceStatus = st.status === 'reconnect_required' ? 'reconnect_required' : r.stale ? 'failed' : 'ok';
      return { items, sources: [{ source: 'siasb' as const, status }] };
    } catch {
      return { items: [], sources: [{ source: 'siasb' as const, status: 'failed' as const }] };
    }
  }
}
