import {
  SourceError,
  type AuthMode,
  type Provider,
  type SourceContext,
  type SourceFetchResult,
  type SourceGateway,
  type SyncScope,
} from '../../../application/ports/source-gateway';
import {
  SigaaRateLimitedError,
  createSigaaHttpClient,
  type SigaaHttpClient,
} from './http-client';
import {
  parseHistoryMenuPostback,
  parseStudentProfile,
  type StudentProfile,
} from './parsers';
import {
  SigaaInvalidCredentialsError,
  SigaaLoginUnavailableError,
  SigaaSession,
  SigaaSessionExpiredError,
  type SigaaCredentials,
} from './session';

const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

export interface SigaaSnapshot {
  profile: StudentProfile;
  /** Presente só quando pedido; o PDF nunca é logado nem gravado aqui. */
  transcriptPdf?: Buffer;
}

function credentialsOf(ctx: SourceContext): SigaaCredentials {
  if (ctx.credentials.kind !== 'password') {
    throw new SourceError(
      'CREDENTIAL_REJECTED',
      'O SIGAA exige usuário e senha por requisição',
    );
  }
  return {
    login: ctx.credentials.username,
    password: ctx.credentials.password,
  };
}

/** Erros da sessão viram códigos estáveis; a mensagem nunca carrega senha nem corpo de resposta. */
function toSourceError(error: unknown): unknown {
  if (error instanceof SigaaInvalidCredentialsError) {
    return new SourceError('CREDENTIAL_REJECTED', error.message);
  }
  if (error instanceof SigaaSessionExpiredError) {
    return new SourceError('REAUTH_NEEDED', error.message);
  }
  if (error instanceof SigaaLoginUnavailableError) {
    return new SourceError('BLOCKED', error.message);
  }
  if (error instanceof SigaaRateLimitedError) {
    return new SourceError('UNAVAILABLE', error.message);
  }
  return error;
}

/**
 * Gateway do SIGAA. Segredo por requisição: a senha vem no contexto, vive só na chamada e nunca
 * é guardada nem logada. O SIGAA não tem boletim da turma atual, então `fetch` entrega só o
 * perfil; itens, espaços e eventos não existem nesta fonte (lista ausente, não "tudo removido").
 * O PDF do histórico sai por `fetchSnapshot`, para o caso de uso de importação do histórico.
 */
export class SigaaGateway implements SourceGateway {
  readonly provider: Provider = 'SIGAA';
  readonly auth: AuthMode = 'segredo-por-requisicao';

  constructor(
    private readonly http: SigaaHttpClient = createSigaaHttpClient(),
  ) {}

  async fetch(ctx: SourceContext, scope: SyncScope): Promise<SourceFetchResult> {
    if (scope.kind !== 'tudo') {
      throw new SourceError(
        'UNSUPPORTED_SCOPE',
        'O SIGAA só sincroniza o alcance "tudo"',
      );
    }
    const { profile } = await this.fetchSnapshot(ctx, { transcript: false });
    return {
      profile: {
        registration: profile.registration ?? undefined,
        programName: profile.program ?? undefined,
        entryTerm: profile.entryTerm ?? undefined,
      },
    };
  }

  /** Login + perfil e, opcionalmente, o PDF do histórico. Uma sessão por chamada, descartada ao sair. */
  async fetchSnapshot(
    ctx: SourceContext,
    options: { transcript: boolean },
  ): Promise<SigaaSnapshot> {
    const credentials = credentialsOf(ctx);
    try {
      const session = new SigaaSession(this.http);
      await session.login(credentials);
      // Um postback JSF só vale contra uma view que o servidor já renderizou nesta sessão.
      const portalHtml = await session.get(PORTAL_HOME_PATH);
      const snapshot: SigaaSnapshot = {
        profile: parseStudentProfile(portalHtml),
      };
      if (options.transcript) {
        snapshot.transcriptPdf = await this.downloadTranscript(
          session,
          portalHtml,
        );
      }
      return snapshot;
    } catch (error) {
      throw toSourceError(error);
    }
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
      throw new SourceError(
        'UNAVAILABLE',
        `Esperava um PDF do histórico, vieram ${pdf.length} bytes que não começam com %PDF`,
      );
    }
    return pdf;
  }
}
