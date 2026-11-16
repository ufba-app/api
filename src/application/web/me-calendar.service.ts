import { todayInBahia } from '../calendar/calendar-alerts';
import type { PublishedCalendarView } from '../calendar/published-calendar';
import type { AgendaSigaa } from '../ports/live-source';
import { expandClass, type ClassSchedule, type SchedulePeriod } from '../../domain/academic/class-schedule';
import { isMarked } from '../../domain/siasb/clinical-state';
import { FonteNaoConectadaError, type Quem } from '../live/consulta.service';
import { ApiError } from './web-api';

export type CalendarSourceName = 'sigaa' | 'siasb';
export type CalendarSourceStatus = 'ok' | 'failed' | 'reconnect_required';
export type CalendarItemKind = 'class' | 'deadline' | 'exam' | 'session';
/** Estado do SIGAA nesta sessão (o mesmo de `/me`): só `connected` lê; `password_required`/`locked` pedem reconectar. */
export type SigaaState = 'connected' | 'disconnected' | 'password_required' | 'locked';

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
  sigaa: {
    /** Turmas com horário e prazos do SIGAA numa passada (UMA leitura do portal; até 1 + 2×8 requisições sequenciais). */
    agenda(q: Quem): Promise<AgendaSigaa>;
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
const SOURCE_TIMEOUT_MS = 20_000;
/** Teto da leitura do SIGAA (portal + até 8 turmas, 2 requisições cada, em sequência). */
const SIGAA_TIMEOUT_MS = 60_000;
/** A leitura do SIGAA vale por pessoa, não por intervalo: navegar entre meses reaproveita (e poupa o JSF sequencial do SIGAA). */
const SIGAA_CACHE_TTL_MS = 12 * 60_000;
const SIGAA_CACHE_MAX = 200;
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

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const withTimeout = <T>(p: Promise<T>, ms = SOURCE_TIMEOUT_MS): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

const EXAM_WORDS = /\b(prova|exame|teste|avalia[cç][aã]o|p[1-9])\b/i;
const DELIVERY_WORDS = /\b(entrega|trabalho|relat[óo]rio|lista|projeto|tarefa|atividade|exerc[íi]cios?|monografia|artigo)s?\b/i;

/**
 * As datas que o SIGAA expõe (a lista "Avaliações" da turma) são, em geral, provas: `exam`. Quando a descrição diz que é uma ENTREGA
 * (trabalho, relatório, lista, projeto...), é `deadline`; "prova"/"exame"/"teste"/"avaliação" na descrição vence. A API classifica: o
 * web não adivinha pelo texto. NÃO validado contra o SIGAA real (o repertório de descrições é do professor).
 */
export function classifySigaaDeadline(titulo: string): 'deadline' | 'exam' {
  if (EXAM_WORDS.test(titulo)) return 'exam';
  return DELIVERY_WORDS.test(titulo) ? 'deadline' : 'exam';
}

/**
 * `GET /me/calendar`: compila o que a pessoa tem em cada dia num formato pronto para desenhar. Só três coisas: (1) feriados e
 * dias sem aula do calendário acadêmico da UFBA (intervalos já expandidos); (2) as AULAS, pela recorrência que o próprio SIGAA
 * aponta (turmas do semestre com dia, horário e período, ex. "35T45"), excluídas nos feriados e dias sem aula; (3) as sessões
 * marcadas do SIASB, para quem tem acesso (sem dado de paciente, não excluídas em feriado). Entregas e provas do Moodle e do
 * Classroom NÃO entram. Falha de uma fonte não derruba a rota: ela vira `sources[].status`.
 */
export class MeCalendar {
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; value: MeCalendarView }>();
  private readonly sigaaCache = new Map<string, { at: number; value: AgendaSigaa }>();
  private readonly sigaaPendente = new Map<string, Promise<AgendaSigaa>>();

  constructor(private readonly d: MeCalendarDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async get(q: Quem, from: string, to: string, sigaa: SigaaState = 'disconnected'): Promise<MeCalendarView> {
    const a = parseDay(from);
    const b = parseDay(to);
    if (a === null || b === null || b < a || (b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) throw invalid();

    const key = `${q.userId}|${from}|${to}|${sigaa}`;
    const hit = this.cache.get(key);
    if (hit && this.now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;

    const [calendar, siasb] = await Promise.all([this.holidays(a, b), this.sessions(q.userId, a, b)]);
    const classes = await this.classes(q, sigaa, from, to, calendar);
    const days = new Map<string, { date: string; nonTeaching: { name: string } | null; items: CalendarItem[] }>();
    const day = (date: string) => {
      let r = days.get(date);
      if (!r) days.set(date, (r = { date, nonTeaching: null, items: [] }));
      return r;
    };
    for (const [date, name] of calendar.nonTeaching) day(date).nonTeaching = { name };
    for (const it of [...classes.items, ...siasb.items]) {
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
      sources: [...classes.sources, ...siasb.sources],
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
  private async holidays(a: number, b: number) {
    const nonTeaching = new Map<string, string>();
    let term: string | null = null;
    let termPeriod: SchedulePeriod | null = null;
    let best = 0;
    for (const c of await this.d.calendars.all()) {
      const start = parseDay(c.keyDates.termStart);
      const end = parseDay(c.keyDates.termEnd);
      if (start !== null && end !== null) {
        const overlap = Math.min(end, b) - Math.max(start, a);
        if (overlap >= 0 && overlap >= best) {
          best = overlap;
          term = c.document.term;
          termPeriod = { start: c.keyDates.termStart, end: c.keyDates.termEnd };
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
    return { term, termPeriod, nonTeaching };
  }

  /**
   * As aulas: cada turma do portal do SIGAA vira uma `class` por dia da recorrência, dentro do período da própria turma (ou do
   * semestre do calendário, se o portal não o mostrar) e SEM os dias com `nonTeaching`. Entrega e prova do AVA não entram aqui.
   */
  /**
   * A leitura do SIGAA (turmas + prazos), 12 min por pessoa em cache e com as leituras simultâneas da mesma pessoa fundidas numa só
   * (o SIGAA/JSF é sequencial por sessão). Só leitura COMPLETA entra no cache: a incompleta é refeita na próxima.
   */
  private lerSigaa(q: Quem): Promise<AgendaSigaa> {
    const hit = this.sigaaCache.get(q.userId);
    if (hit && this.now().getTime() - hit.at < SIGAA_CACHE_TTL_MS) return Promise.resolve(hit.value);
    const andamento = this.sigaaPendente.get(q.userId);
    if (andamento) return andamento;
    const p = withTimeout(this.d.sigaa.agenda(q), SIGAA_TIMEOUT_MS)
      .then((value) => {
        if (value.prazosCompletos) {
          if (this.sigaaCache.size >= SIGAA_CACHE_MAX) this.sigaaCache.delete(this.sigaaCache.keys().next().value as string);
          this.sigaaCache.set(q.userId, { at: this.now().getTime(), value });
        }
        return value;
      })
      .finally(() => this.sigaaPendente.delete(q.userId));
    this.sigaaPendente.set(q.userId, p);
    return p;
  }

  private async classes(q: Quem, state: SigaaState, from: string, to: string, calendar: { termPeriod: SchedulePeriod | null; nonTeaching: Map<string, string> }) {
    const none = { items: [] as CalendarItem[], sources: [] as MeCalendarView['sources'] };
    if (state === 'disconnected') return none;
    if (state === 'password_required' || state === 'locked') return { items: [], sources: [{ source: 'sigaa' as const, status: 'reconnect_required' as const }] };
    let agenda: AgendaSigaa;
    try {
      agenda = await this.lerSigaa(q);
    } catch (e) {
      return { items: [], sources: [{ source: 'sigaa' as const, status: (e instanceof FonteNaoConectadaError ? 'reconnect_required' : 'failed') as CalendarSourceStatus }] };
    }
    const off = (date: string) => calendar.nonTeaching.has(date);
    const items: CalendarItem[] = agenda.turmas.flatMap((t) =>
      expandClass(t, from, to, off, calendar.termPeriod).map<CalendarItem>((o) => ({
        id: `sigaa:${slug(t.name)}:${o.date}:${o.start.replace(':', '')}`,
        kind: 'class',
        source: 'sigaa',
        title: t.name,
        courseName: t.name,
        courseCode: t.courseCode, // o portal da UFBA costuma trazer só o nome: então é null
        startsAt: `${o.date}T${o.start}:00-03:00`,
        endsAt: `${o.date}T${o.end}:00-03:00`,
        place: t.placeByWeekday[o.weekday] ?? null,
      })),
    );
    // Prazos e provas (as datas que o SIGAA expõe): entrega termina no prazo; prova começa na hora. Só de hoje em diante (a fonte não traz o passado).
    for (const p of agenda.prazos) {
      const kind = classifySigaaDeadline(p.titulo);
      const iso = bahiaIso(p.quando);
      const date = iso.slice(0, 10);
      if (date < from || date > to) continue;
      items.push({
        id: `sigaa:${p.id}`,
        kind,
        source: 'sigaa',
        title: p.titulo,
        courseName: p.cursoNome ?? null,
        courseCode: null,
        startsAt: kind === 'exam' ? iso : null,
        endsAt: kind === 'deadline' ? iso : null,
        place: 'SIGAA',
      });
    }
    // Prazos que pararam no meio (falha ou tempo): as aulas ficam e o aviso é da fonte, não da rota.
    return { items, sources: [{ source: 'sigaa' as const, status: (agenda.prazosCompletos ? 'ok' : 'failed') as CalendarSourceStatus }] };
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
