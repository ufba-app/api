import type { SiasbLink } from '../../application/siasb/siasb-link';
import type { SiasbCopyReader } from '../../application/siasb/siasb-copy-reader';
import type { SiasbReader } from '../../application/siasb/siasb-reader';
import { DAY_MS, resolveSessionPeriod, SYNC_LOOKBACK_DAYS } from '../../application/siasb/session-period';
import type { McpClinica } from './mcp-ports';

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
    const period = resolveSessionPeriod(now, range);
    // Período além do alcance, ou começando antes da janela sincronizada: a cópia não responde (quem chama lê ao vivo).
    if (period.kind === 'empty') return null;
    if (period.from.getTime() < now.getTime() - SYNC_LOOKBACK_DAYS * DAY_MS) return null;
    return this.copyReader.calendar(userId, period.from, period.to);
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
