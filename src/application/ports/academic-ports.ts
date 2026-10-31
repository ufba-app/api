import type { TranscriptData } from '../../domain/academic';
import type { AttachmentContent, AttachmentRef } from './attachment-reader';
import type { Provider, SourceContext } from './source-gateway';

/** Grava o histórico acadêmico importado (substitui o anterior do usuário). Devolve a data da importação. */
export abstract class TranscriptRepository {
  abstract save(userId: string, data: TranscriptData): Promise<Date>;
}

/** Baixa o PDF do histórico na fonte (SIGAA). A senha vive só em `ctx`, em memória. */
export abstract class TranscriptSource {
  abstract fetchTranscriptPdf(ctx: SourceContext): Promise<Buffer>;
}

export interface AttachmentLocation {
  provider: Provider;
  sourceAccountId: string;
  ref: AttachmentRef;
}

/** Acha um anexo do usuário (nunca de outro) a partir dos ids do banco. */
export abstract class AttachmentLookup {
  abstract find(
    userId: string,
    itemId: string,
    attachmentId: string,
  ): Promise<AttachmentLocation | null>;
}

/** Leitor de anexos de UMA fonte, já sobre credenciais decifradas. */
export interface SourceAttachmentReader {
  read(ctx: SourceContext, ref: AttachmentRef): Promise<AttachmentContent>;
}

/** Leitores por fonte (só as que têm anexo sob demanda). */
export abstract class AttachmentReaders {
  abstract get(provider: Provider): SourceAttachmentReader | undefined;
}
