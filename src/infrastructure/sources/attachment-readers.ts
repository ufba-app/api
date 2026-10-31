import {
  AttachmentReaders,
  type SourceAttachmentReader,
} from '../../application/ports/academic-ports';
import type { AttachmentReader } from '../../application/ports/attachment-reader';
import { SourceError, type Provider } from '../../application/ports/source-gateway';
import type { MoodleAttachmentReader } from './moodle/moodle-attachment-reader';

/** Drive (Classroom): o "token" decifrado da conta é o refresh token. */
function fromDrive(reader: AttachmentReader): SourceAttachmentReader {
  return {
    async read(ctx, ref) {
      if (ctx.credentials.kind !== 'token') {
        throw new SourceError('CREDENTIAL_REJECTED', 'Conta Google sem token guardado');
      }
      return reader.read({ refreshToken: ctx.credentials.token }, ref);
    },
  };
}

function fromMoodle(reader: MoodleAttachmentReader): SourceAttachmentReader {
  return {
    async read(ctx, ref) {
      if (!ref.sourceUrl) throw new SourceError('UNSUPPORTED_SCOPE', 'Anexo sem URL na fonte');
      const r = await reader.read(ctx, ref.sourceUrl);
      return { bytes: new Uint8Array(r.content), mimeType: r.mimeType, fileName: r.fileName };
    },
  };
}

/** Leitores de anexo por fonte: Classroom (Drive) e Moodle. O SIGAA não tem anexos sob demanda. */
export class SourceAttachmentReaders extends AttachmentReaders {
  private readonly map = new Map<Provider, SourceAttachmentReader>();

  constructor(parts: { drive?: AttachmentReader; moodle?: MoodleAttachmentReader }) {
    super();
    if (parts.drive) this.map.set('CLASSROOM', fromDrive(parts.drive));
    if (parts.moodle) this.map.set('MOODLE', fromMoodle(parts.moodle));
  }

  get(provider: Provider): SourceAttachmentReader | undefined {
    return this.map.get(provider);
  }
}
