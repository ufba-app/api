import type { SiasbLink } from '../../application/siasb/siasb-link';
import type { SiasbReader } from '../../application/siasb/siasb-reader';
import type { McpClinica } from './mcp-ports';

/** Liga as ferramentas `clinica_*` ao leitor e ao vínculo do SIASB. */
export class McpClinicaImpl implements McpClinica {
  constructor(
    private readonly reader: SiasbReader,
    private readonly link: SiasbLink,
  ) {}

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
}
