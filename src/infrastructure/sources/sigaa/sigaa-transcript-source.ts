import { TranscriptSource } from '../../../application/ports/academic-ports';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import type { SigaaGateway } from './sigaa-gateway';

/** Entrega o PDF do histórico pelo `SigaaGateway.fetchSnapshot`. Uma sessão por chamada; a senha não é guardada. */
export class SigaaTranscriptSource extends TranscriptSource {
  constructor(private readonly gateway: SigaaGateway) {
    super();
  }

  async fetchTranscriptPdf(ctx: SourceContext): Promise<Buffer> {
    const snap = await this.gateway.fetchSnapshot(ctx, { transcript: true });
    if (!snap.transcriptPdf) {
      throw new SourceError('UNAVAILABLE', 'O SIGAA não devolveu o histórico');
    }
    return snap.transcriptPdf;
  }
}
