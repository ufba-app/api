import type { Secret } from '../../../application/shared/secret';
import type { AttachmentContent, AttachmentReader, AttachmentRef } from '../../../application/ports/attachment-reader';
import { GoogleHttp } from '../google/google-http';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

/** Tipos nativos do Google exportados para um formato legível. */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: '.csv' },
};

const MAX_BYTES = 25 * 1024 * 1024;

export class AttachmentTooLargeError extends Error {}
export class UnsupportedAttachmentError extends Error {}

function driveIdOf(ref: AttachmentRef): string | null {
  if (ref.externalId) return ref.externalId;
  const m = ref.sourceUrl?.match(/\/d\/([\w-]+)|[?&]id=([\w-]+)/);
  return m ? (m[1] ?? m[2]) : null;
}

/** Baixa o conteúdo de arquivos do Drive (texto/PDF -> bytes) sob demanda. */
export class DriveAttachmentReader implements AttachmentReader {
  constructor(private readonly http: GoogleHttp) {}

  async read(credentials: { refreshToken: Secret }, ref: AttachmentRef): Promise<AttachmentContent> {
    const id = driveIdOf(ref);
    if (!id) throw new UnsupportedAttachmentError('Anexo sem id do Drive');
    const rt = credentials.refreshToken;
    const url = `${DRIVE}/${encodeURIComponent(id)}`;

    const meta = await this.http.getJson<{ name?: string; mimeType?: string; size?: string }>(rt, url, {
      fields: 'id,name,mimeType,size',
    });
    const mime = meta.mimeType ?? ref.mimeType ?? 'application/octet-stream';
    if (meta.size && Number(meta.size) > MAX_BYTES) {
      throw new AttachmentTooLargeError(`Arquivo maior que ${MAX_BYTES} bytes`);
    }

    const exp = EXPORTS[mime];
    if (exp) {
      const res = await this.http.get(rt, `${url}/export`, { mimeType: exp.mime });
      return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: exp.mime, fileName: (meta.name ?? id) + exp.ext };
    }
    if (mime.startsWith('application/vnd.google-apps.')) {
      throw new UnsupportedAttachmentError(`Tipo não exportável: ${mime}`);
    }
    const res = await this.http.get(rt, url, { alt: 'media' });
    return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: mime, fileName: meta.name };
  }
}
