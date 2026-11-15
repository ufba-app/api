import { TranscriptSource, type TranscriptSnapshot } from '../../../../application/ports/academic';
import type { Secret } from '../../../../application/shared/secret';
import { parseStudentProfile } from '../parsers';
import type { SessoesSigaa } from '../sessoes-sigaa';
import { erroDaFonte } from '../sigaa-live';
import { PORTAL_HOME_PATH, downloadTranscriptPdf } from './transcript-download';

/**
 * Fonte do PDF do histórico: o SIGAA, pela sessão da pessoa (`SessoesSigaa`: reaproveita o cookie guardado e só abre a
 * senha se for preciso logar; uma consulta por vez por pessoa). São 2 requisições: o portal (perfil) e o menu "Emitir
 * Histórico" (o PDF). O PDF nunca é gravado nem logado; erros viram `SourceError` com mensagem fixa.
 */
export class SessionTranscriptSource extends TranscriptSource {
  constructor(private readonly sessoes: SessoesSigaa) {
    super();
  }

  async fetch(i: { userId: string; login: string; password: Secret }): Promise<TranscriptSnapshot> {
    try {
      return await this.sessoes.usar(
        { userId: i.userId, login: i.login.trim().toLowerCase() },
        async () => ({ login: i.login, password: i.password }),
        async (session) => {
          const portalHtml = await session.get(PORTAL_HOME_PATH);
          const profile = parseStudentProfile(portalHtml);
          return { pdf: await downloadTranscriptPdf(session, portalHtml), profile };
        },
      );
    } catch (e) {
      throw erroDaFonte(e);
    }
  }
}
