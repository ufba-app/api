import {
  createSigaaHttpClient,
  type SigaaHttpClient,
} from './http-client';
import {
  parseHistoryMenuPostback,
  parseStudentProfile,
  type StudentProfile,
} from './parsers';
import { SigaaSession, type SigaaCredentials } from './session';

const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

export interface SigaaFetchContext {
  /** Vem da requisição de `sincronizar`; usada em memória e descartada. Nunca guardar nem logar. */
  credentials: SigaaCredentials;
}

export type SigaaScope = 'all' | 'profile' | 'transcript';

/**
 * Forma do CONTRATO (`fetch(ctx, scope) -> {items, courseSpaces, events...}`) até a porta
 * SourceGateway existir. O SIGAA não tem boletim da turma atual, então `items`, `courseSpaces` e
 * `events` vêm vazios; entrega o perfil e o PDF do histórico (que o extrator transforma em dados).
 */
export interface SigaaFetchResult {
  items: never[];
  courseSpaces: never[];
  events: never[];
  profile?: StudentProfile;
  transcriptPdf?: Buffer;
}

/** Como a fonte autentica: segredo por requisição, nunca guardado (ARQUITETURA §2.3). */
export const SIGAA_AUTH_MODE = 'segredo-por-requisição' as const;

export class SigaaGateway {
  readonly source = 'sigaa' as const;
  readonly authMode = SIGAA_AUTH_MODE;

  constructor(
    private readonly http: SigaaHttpClient = createSigaaHttpClient(),
  ) {}

  async fetch(
    ctx: SigaaFetchContext,
    scope: SigaaScope = 'all',
  ): Promise<SigaaFetchResult> {
    // Uma sessão por chamada, só em memória, descartada ao sair.
    const session = new SigaaSession(this.http);
    await session.login(ctx.credentials);

    // Um postback JSF só vale contra uma view que o servidor já renderizou nesta sessão.
    const portalHtml = await session.get(PORTAL_HOME_PATH);
    const result: SigaaFetchResult = {
      items: [],
      courseSpaces: [],
      events: [],
    };

    if (scope === 'all' || scope === 'profile') {
      result.profile = parseStudentProfile(portalHtml);
    }
    if (scope === 'all' || scope === 'transcript') {
      result.transcriptPdf = await this.downloadTranscript(
        session,
        portalHtml,
      );
    }
    return result;
  }

  private async downloadTranscript(
    session: SigaaSession,
    portalHtml: string,
  ): Promise<Buffer> {
    const { id, jscookAction } = parseHistoryMenuPostback(portalHtml);
    const pdf = await session.postbackBinary(PORTAL_HOME_PATH, {
      'menu:form_menu_discente': 'menu:form_menu_discente',
      id,
      jscook_action: jscookAction,
    });
    // Falhas (sessão perdida, sem vínculo) voltam como HTML 200: nunca entregar isso como documento.
    if (!pdf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new Error(
        `Esperava um PDF do histórico, vieram ${pdf.length} bytes que não começam com %PDF`,
      );
    }
    return pdf;
  }
}
