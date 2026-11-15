import type { SiasbLink } from '../../application/siasb/siasb-link';
import type { SiasbCopyReader } from '../../application/siasb/siasb-copy-reader';
import { InvalidPeriodError, type SiasbReader } from '../../application/siasb/siasb-reader';
import type { McpClinica } from './mcp-ports';

const DAY_MS = 86_400_000;

/** Liga as ferramentas `clinica_*` ao leitor e ao vínculo do SIASB. */
export class McpClinicaImpl implements McpClinica {
  constructor(
    private readonly reader: SiasbReader,
    private readonly link: SiasbLink,
    private readonly copyReader: SiasbCopyReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async copySessions(userId: string, range?: { from: Date; to: Date }) {
    const now = this.now();
    const from = range?.from ?? now;
    const wanted = range?.to ?? new Date(from.getTime() + 14 * DAY_MS);
    if (from.getTime() > wanted.getTime()) throw new InvalidPeriodError();
    const limit = new Date(now.getTime() + 45 * DAY_MS);
    const to = wanted.getTime() > limit.getTime() ? limit : wanted;
    if (from.getTime() > to.getTime()) {
      const empty = await this.copyReader.calendar(userId, from, from);
      return { ...empty, items: [] };
    }
    const start = new Date(Math.max(from.getTime(), to.getTime() - 190 * DAY_MS));
    return this.copyReader.calendar(userId, start, to);
  }

  async hasConnection(userId: string): Promise<boolean> {
    return (await this.link.status(userId)).state !== 'disconnected';
  }
  situation(userId: string) {
    return this.reader.situation(userId);
  }
  sessions(userId: string, range?: { from: Date; to: Date }) {
    return this.reader.sessions(userId, range);
  }
  bookingDeadline(userId: string, input: { disciplineId: string } | { sessionStart: Date }) {
    return this.reader.bookingDeadline(userId, input);
  }
  patients(userId: string) {
    return this.reader.patients(userId);
  }
  vacancies(userId: string) {
    return this.reader.vacancies(userId);
  }
  schedulingContext(userId: string, attendanceId: string, term?: string) {
    return this.reader.schedulingContext(userId, attendanceId, term);
  }
  progress(userId: string, range?: { from: Date; to: Date }) {
    return this.reader.progress(userId, range);
  }
}
