import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CalendarDocument } from '../../src/application/calendar/contract';
import {
  CalendarLogRepository,
  CalendarReader,
  CalendarSource,
  CalendarTextExtractor,
  type CalendarLink,
  type CalendarLogRow,
  type NewCalendarLog,
} from '../../src/application/ports/calendar';

const fixtureDir = join(__dirname, '..', '..', 'src', 'application', 'calendar', '__fixtures__');
const fixture = (name: string) => readFileSync(join(fixtureDir, name), 'utf-8');

/** Texto extraído do calendário 2026.2 (público). */
export const CALENDAR_TEXT = fixture('calendar-2026.2.txt');
/** O que um leitor PERFEITO devolveria desse calendário (a saída real, verificada, sem os campos que a conferência acrescenta). */
export const perfectCalendar = (): CalendarDocument => {
  const { contractVersion: _v, verification: _c, ...doc } = JSON.parse(fixture('calendar-2026.2.json')) as Record<string, unknown>;
  return doc as unknown as CalendarDocument;
};
/** Uma leitura que não fecha: o total de dias letivos não bate com a soma dos meses. */
export const brokenCalendar = (): CalendarDocument => {
  const doc = perfectCalendar();
  doc.teachingDays.total += 7;
  return doc;
};
export const SUPAC_PAGE_HTML = fixture('supac-page.html');

export class InMemoryCalendarLogs extends CalendarLogRepository {
  rows: CalendarLogRow[] = [];
  private seq = 0;
  now: () => Date = () => new Date();

  async findBySha(sha: string) {
    return this.rows.find((r) => r.sourceSha256 === sha) ?? null;
  }
  async findErrorByUrl(url: string) {
    return this.rows.find((r) => r.sourceUrl === url && r.status === 'ERROR' && r.sourceSha256 === null) ?? null;
  }
  async create(row: NewCalendarLog) {
    const at = this.now();
    const created: CalendarLogRow = { ...row, id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`, createdAt: at, updatedAt: at, seen: false, seenBy: null, seenAt: null };
    this.rows.push(created);
    return created;
  }
  async update(id: string, row: NewCalendarLog) {
    const i = this.rows.findIndex((r) => r.id === id);
    this.rows[i] = { ...this.rows[i]!, ...row, updatedAt: this.now() };
    return this.rows[i]!;
  }
  async markSeen(id: string, userId: string, at: Date) {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.rows[i] = { ...this.rows[i]!, seen: true, seenBy: userId, seenAt: at };
    return this.rows[i]!;
  }
  async listUnseenProblems() {
    return this.rows.filter((r) => !r.seen && r.status !== 'PUBLISHED');
  }
  async knownTerms() {
    return this.rows.map((r) => r.term).filter((t): t is string => t !== null);
  }
  async listPublished() {
    const latest = new Map<string, CalendarLogRow>();
    for (const r of [...this.rows].reverse()) if (r.status === 'PUBLISHED' && r.term && !latest.has(r.term)) latest.set(r.term, r);
    return [...latest.values()];
  }
}

/** Página e PDFs falsos: `pdfs` mapeia URL → bytes (ou o erro a lançar). Conta as chamadas. */
export class FakeCalendarSource extends CalendarSource {
  links: CalendarLink[] = [];
  pageError: Error | null = null;
  pdfs = new Map<string, Buffer | Error>();
  downloads = 0;
  pageUrl() {
    return 'https://supac.ufba.br/calendario-academico';
  }
  async listLinks() {
    if (this.pageError) throw this.pageError;
    return this.links;
  }
  async download(url: string) {
    this.downloads++;
    const r = this.pdfs.get(url);
    if (!r) throw new Error('HTTP 404');
    if (r instanceof Error) throw r;
    return r;
  }
}

export class FakeCalendarText extends CalendarTextExtractor {
  text = CALENDAR_TEXT;
  async extract() {
    return this.text;
  }
}

/** Leitor falso: devolve as respostas na ordem (a última se repete); `Error` na fila é lançado. */
export class FakeCalendarReader extends CalendarReader {
  queue: Array<CalendarDocument | Error> = [perfectCalendar()];
  calls = 0;
  async read() {
    const next = this.queue[Math.min(this.calls, this.queue.length - 1)]!;
    this.calls++;
    if (next instanceof Error) throw next;
    return { document: next, usage: { inputTokens: 20_000, outputTokens: 20_000 } };
  }
}
