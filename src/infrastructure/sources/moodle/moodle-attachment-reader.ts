import { MoodleError, type FetchFn } from './moodle-client';
import type { SourceContext } from '../../../application/ports/source-gateway';
import { accessOf } from './moodle-access';

export interface AttachmentReader {
  read(
    ctx: SourceContext,
    sourceUrl: string,
  ): Promise<{ content: Buffer; mimeType: string; fileName?: string }>;
}

/** Baixa o arquivo sob demanda anexando `token=` à URL do Moodle. O token nunca é logado nem devolvido. */
export class MoodleAttachmentReader implements AttachmentReader {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async read(sourceCtx: SourceContext, sourceUrl: string) {
    const ctx = accessOf(sourceCtx);
    const base = new URL(ctx.baseUrl);
    const target = new URL(sourceUrl);
    // O token só pode ir para o Moodle da própria conta.
    if (target.origin !== base.origin) {
      throw new MoodleError('URL do anexo não pertence ao Moodle da conta');
    }
    target.searchParams.set('token', ctx.token.reveal());
    const res = await this.fetchFn(target.toString(), { redirect: 'follow' });
    if (!res.ok) {
      throw new MoodleError(`Moodle HTTP ${res.status} ao baixar anexo`);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return {
      content: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      fileName: match ? decodeURIComponent(match[1]) : undefined,
    };
  }
}
