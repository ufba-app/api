/**
 * Porta das fontes (SIGAA, Moodle, Classroom, Calendar). Cada fonte implementa `SourceGateway` em
 * `infrastructure/sources/<fonte>/`. O gateway só BUSCA e NORMALIZA; quem grava e detecta mudança é o caso de uso
 * `sincronizar`. Ver docs/ARQUITETURA.md §2.2 e §2.3.
 */

export type Provider = 'SIGAA' | 'MOODLE' | 'CLASSROOM' | 'CALENDAR';

export type ItemKind =
  | 'ANNOUNCEMENT'
  | 'ASSIGNMENT'
  | 'ASSESSMENT'
  | 'MATERIAL'
  | 'FORUM_TOPIC'
  | 'OTHER';

/** Como a fonte autentica. Fixa a regra do SIGAA na estrutura do código (§2.3). */
export type AuthMode = 'token-guardado' | 'segredo-por-requisicao';

/** Alcance do `sincronizar`. */
export type SyncScope =
  | { kind: 'tudo' }
  | { kind: 'curso'; courseExternalId: string }
  | { kind: 'item'; courseExternalId: string; itemExternalId: string };

/**
 * Credencial usada SÓ em memória durante o `fetch`. `password` (SIGAA) nunca é persistida nem logada.
 * `token` é o token já decifrado de uma conta `token-guardado` (Moodle, Google).
 */
export type SourceCredentials =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'token'; token: string };

export interface SourceContext {
  userId: string;
  /** Identifica a conta na fonte: "sigaa", host+usuário do Moodle, e-mail do Google. */
  accountKey: string;
  siteUrl?: string;
  credentials: SourceCredentials;
  /** Chave da sessão na fonte (SIGAA: `userId:clientId`), para reaproveitar o login entre consultas. */
  sessaoKey?: string;
}

export interface FetchedCourseSpace {
  externalId: string;
  name: string;
  extra?: Record<string, unknown>;
}

export interface FetchedAttachment {
  externalId?: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl?: string;
}

export interface FetchedItem {
  /** `externalId` do CourseSpace a que o item pertence. */
  courseExternalId: string;
  kind: ItemKind;
  externalId: string;
  title: string;
  body?: string;
  dueAt?: Date;
  publishedAt?: Date;
  state?: string;
  extra?: Record<string, unknown>;
  attachments?: FetchedAttachment[];
}

export interface FetchedEvent {
  calendarId: string;
  externalId: string;
  title: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt?: Date;
  allDay?: boolean;
  status?: string;
}

export interface FetchedGrade {
  courseExternalId: string;
  /** Item de origem, quando a fonte informa. */
  itemExternalId?: string;
  externalId: string;
  label: string;
  score?: number;
  maxScore?: number;
  weight?: number;
  gradedAt?: Date;
}

export interface FetchedProfile {
  registration?: string;
  programName?: string;
  entryTerm?: string;
}

/** Resultado normalizado. Lista ausente = a fonte não fornece aquilo (não significa "tudo removido"). */
export interface SourceFetchResult {
  courseSpaces?: FetchedCourseSpace[];
  items?: FetchedItem[];
  events?: FetchedEvent[];
  grades?: FetchedGrade[];
  profile?: FetchedProfile;
  /**
   * Cursos (`courseExternalId`) cujos itens/notas a fonte NÃO conseguiu trazer nesta rodada (ex.: 504 do AVA).
   * O que já está guardado desses cursos não é tratado como removido.
   */
  partial?: { items?: string[]; grades?: string[] };
  /** Avisos legíveis sobre o que ficou de fora (sem segredos). */
  warnings?: string[];
}

export type SourceErrorCode =
  | 'CREDENTIAL_REJECTED'
  | 'REAUTH_NEEDED'
  | 'BLOCKED'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED_SCOPE';

/** Erro de fonte com código estável (vai para `SyncRun.errorCode`). */
export class SourceError extends Error {
  constructor(
    public readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SourceGateway {
  readonly provider: Provider;
  readonly auth: AuthMode;
  fetch(ctx: SourceContext, scope: SyncScope): Promise<SourceFetchResult>;
}

/** Registro das fontes disponíveis; o AppModule registra cada gateway com `register`. */
export class SourceRegistry {
  private readonly gateways = new Map<Provider, SourceGateway>();

  register(gateway: SourceGateway): void {
    this.gateways.set(gateway.provider, gateway);
  }

  get(provider: Provider): SourceGateway | undefined {
    return this.gateways.get(provider);
  }

  list(): SourceGateway[] {
    return [...this.gateways.values()];
  }
}
