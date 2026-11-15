import { z } from "zod";

/**
 * Contrato da API do app web: fonte única. O mesmo schema valida a entrada, dá o tipo (`z.infer`) e gera o OpenAPI
 * (`interface/web/openapi.ts`, `npm run openapi`). Mudou aqui, regenere o `openapi.json` (o CI confere).
 */

// ---- erros ----

export const API_ERROR_CODES = [
  "invalid_request",
  "csrf_rejected",
  "session_expired",
  "not_found",
  "request_not_found",
  "request_expired",
  "invalid_credentials",
  "too_many_attempts",
  "source_unavailable",
  "source_not_connected",
  "source_account_taken",
  "source_account_mismatch",
  "source_account_not_owned",
  "account_ambiguous",
  "not_supported",
  "device_code_invalid",
  "device_code_expired",
  "computer_limit_reached",
  "computer_not_found",
  "memory_unavailable",
  "memory_forbidden",
  "project_not_found",
  "project_name_taken",
  "not_project_owner",
  "invalid_email_domain",
  "not_admin",
  "calendar_unavailable",
  "permission_unavailable",
  "calendar_log_not_reprocessable",
  "role_not_found",
  "passkey_limit_reached",
  "passkey_not_found",
  "pairing_not_found",
  "pairing_already_delivered",
  "consent_required",
  "import_in_progress",
  "import_unavailable",
  "import_not_found",
  "curriculum_unavailable",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorBody = z.object({
  error: z.enum(API_ERROR_CODES),
  /** pt-BR, pronta para mostrar. */
  message: z.string(),
});

// ---- estados ----

export const SigaaStatus = z.enum([
  "connected",
  "disconnected",
  "password_required",
  /** Sem a senha nesta sessão, mas há cópia mestra: um toque na passkey religa. */
  "locked",
]);
// ---- chave mestra do SIGAA (passkey) ----

const b64url = (min: number, max: number, bytes?: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((v) => bytes === undefined || Buffer.from(v, "base64url").length === bytes);

/** Id da passkey: até 1023 bytes na especificação (1364 caracteres base64url). */
const CredentialId = b64url(1, 1364);

export const SaveSigaaPasskeyBody = z.object({
  credentialId: CredentialId,
  /** 32 bytes que o navegador usa como salt do PRF. */
  prfSalt: b64url(43, 43, 32),
  /** 12 bytes. */
  iv: b64url(16, 16, 12),
  /** AES-GCM do `{ login, password }` (texto + 16 bytes da tag). */
  ciphertext: b64url(22, 4096),
  label: z.string().trim().min(1).max(40).optional(),
});

export const SigaaPasskeySlotBody = z.object({ credentialId: CredentialId });

export const SigaaPasskeySlot = z.object({
  prfSalt: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
});

export const SigaaPasskeyView = z.object({
  credentialId: z.string(),
  /** Salt do PRF desta passkey (não é segredo): o navegador precisa dele antes do toque (`evalByCredential`). */
  prfSalt: z.string(),
  label: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUnlockedAt: z.string().datetime().nullable(),
});

export const SigaaPasskeysResponse = z.object({ passkeys: z.array(SigaaPasskeyView) });

// ---- vida acadêmica (histórico lido pela IA e adequado ao currículo Ativo do curso) ----

const AcademicHours = z.object({ required: z.number(), completed: z.number(), pending: z.number() });

/** O que foi lido do histórico (o contrato da leitura, sem docente nem identidade). Rascunho até a pessoa confirmar. */
export const AcademicDraft = z.object({
  contractVersion: z.literal("1"),
  document: z.object({ issuedOn: z.string() }),
  program: z.object({
    name: z.string(),
    curriculum: z.string(),
    currentTerm: z.number(),
    completionDeadline: z.object({ standard: z.string(), maximum: z.string() }),
  }),
  indices: z.object({ cr: z.number().nullable(), iap: z.number().nullable() }),
  components: z.array(
    z.object({
      /** Como impresso; "--" nas linhas sem semestre (aproveitamento). */
      term: z.string(),
      kind: z.string().nullable(),
      code: z.string(),
      name: z.string(),
      hours: z.number(),
      grade: z.number().nullable(),
      status: z.string(),
    }),
  ),
  hours: z.object({
    mandatory: AcademicHours,
    elective: AcademicHours,
    complementary: AcademicHours,
    total: AcademicHours,
  }),
  pendingMandatory: z.object({
    declaredTotal: z.number(),
    items: z.array(z.object({ code: z.string(), name: z.string(), hours: z.number(), enrolled: z.boolean() })),
  }),
  equivalences: z.array(z.string()),
  notes: z.array(z.string()),
  verification: z.object({
    /** Falso: a confirmação é obrigatória e a tela mostra os avisos. */
    verified: z.boolean(),
    warnings: z.array(z.string()),
    reader: z.enum(["ai", "parser"]),
  }),
});

export const AcademicSummary = z.object({
  programName: z.string(),
  /** O currículo do próprio aluno, como impresso no histórico ("G20251 - 2025.2"). */
  curriculum: z.string(),
  currentTerm: z.number(),
  completionDeadline: z.object({ standard: z.string(), maximum: z.string() }),
  indices: z.object({ cr: z.number().nullable(), iap: z.number().nullable() }),
  hours: AcademicDraft.shape.hours,
});

export const AcademicFailure = z.enum([
  "REDACTION_REFUSED",
  "READER_FAILED",
  "SIGAA_UNAVAILABLE",
  "PDF_INVALID",
  "SESSION_EXPIRED",
  "TIMEOUT",
]);

export const AcademicState = z.object({
  /** A leitura está disponível neste servidor (há chave do provedor de IA). Falso: esconder a oferta. */
  available: z.boolean(),
  consent: z.boolean(),
  status: z.enum(["NONE", "RUNNING", "NEEDS_CONFIRMATION", "READY", "FAILED"]),
  failure: AcademicFailure.nullable(),
  verified: z.boolean().nullable(),
  reader: z.string().nullable(),
  importedAt: z.string().datetime().nullable(),
  /** A grade do curso: `NONE` (sem histórico), `READY`, `IMPORTING` (sendo buscada) ou `UNAVAILABLE`. */
  curriculumStatus: z.enum(["NONE", "READY", "IMPORTING", "UNAVAILABLE"]),
  /** Só com o histórico gravado. */
  summary: AcademicSummary.nullable(),
  /** Só em `NEEDS_CONFIRMATION`: o que foi lido, para a tela de confirmação. */
  draft: AcademicDraft.nullable(),
});

export const AcademicConsentBody = z.object({ accepted: z.boolean() });

const ComponentProgressView = z.object({
  code: z.string(),
  name: z.string(),
  hours: z.number(),
  nature: z.enum(["REQUIRED", "ELECTIVE", "COMPLEMENTARY"]),
  term: z.number().nullable(),
  state: z.enum(["DONE", "DONE_VIA_EQUIVALENCE", "ENROLLED", "AVAILABLE", "BLOCKED"]),
  /** Códigos que cumpriram este componente por equivalência. */
  via: z.array(z.string()),
  /** Códigos do pré-requisito que o aluno ainda não cumpriu (só em BLOCKED). */
  missingPrerequisites: z.array(z.string()),
  /** O pré-requisito não é uma expressão de códigos verificável (ex.: carga mínima): conferir no SIGAA. */
  prerequisiteUnverifiable: z.boolean(),
  prerequisiteExpr: z.string().nullable(),
  equivalenceExpr: z.string().nullable(),
  late: z.boolean(),
});

const NatureHoursView = z.object({
  needed: z.number(),
  completed: z.number(),
  remaining: z.number(),
  source: z.enum(["document", "estimate"]),
});

/** A grade do curso (currículo Ativo) marcada com o que o aluno já fez. Sempre uma ESTIMATIVA. */
export const AcademicProgress = z.object({
  curriculumCode: z.string(),
  /** O aluno está no mesmo currículo do Ativo; nulo se o histórico não diz. */
  sameCurriculum: z.boolean().nullable(),
  estimate: z.literal(true),
  required: z.array(ComponentProgressView),
  electives: z.array(ComponentProgressView),
  complementary: z.array(ComponentProgressView),
  hours: z.object({
    required: NatureHoursView,
    elective: NatureHoursView,
    complementary: NatureHoursView,
    total: NatureHoursView,
  }),
  percentComplete: z.number().nullable(),
  requiredHoursToTake: z.number(),
  currentTerm: z.number().nullable(),
  terms: z.object({ min: z.number(), avg: z.number(), max: z.number() }),
  divergences: z.object({
    obsoletePending: z.array(z.string()),
    substitutedPending: z.array(z.object({ code: z.string(), substitutedBy: z.string() })),
    satisfiedByAdequation: z.array(z.string()),
    newInCurriculum: z.array(z.string()),
  }),
});

// ---- DK: chave do cofre da senha do SIGAA ----

/** A DK (32 bytes, base64url): o navegador a cifra com a passkey ao ativar e a devolve ao desbloquear. */
export const SigaaKeyResponse = z.object({ dk: b64url(43, 43, 32) });
export const UnlockSigaaBody = z.object({ dk: b64url(43, 43, 32) });

// ---- liberação do SIGAA por QR (correio entre o computador e o celular) ----

export const CreatePairingBody = z.object({
  /** Mostrado no celular: "Firefox no Windows". */
  label: z.string().trim().min(1).max(60).optional(),
  /** Cliente OAuth que está sendo autorizado, se houver. */
  client: z.string().trim().min(1).max(60).optional(),
});

export const PairingCreated = z.object({
  /** 16 bytes em base64url: vai no QR (com a chave pública do computador no fragmento, que não chega ao servidor). */
  id: z.string(),
  expiresAt: z.string().datetime(),
});

export const PairingInfo = z.object({
  /** O que o COMPUTADOR diz de si ("Firefox no Windows"). NÃO é confiável: quem mostra um QR de golpe escreve o que quiser. */
  label: z.string().nullable(),
  client: z.string().nullable(),
  /** O que a API VIU ao receber o pedido, pelo User-Agent ("Firefox 160", "Windows"). É o que o celular deve mostrar primeiro. */
  seenBrowser: z.string().nullable(),
  seenOs: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  delivered: z.boolean(),
});

/** Pacote lacrado do celular: chave pública efêmera (P-256 não comprimida, 65 bytes), iv (12) e AES-GCM. */
export const DeliverPairingBody = z.object({
  pub: b64url(87, 87, 65),
  iv: b64url(16, 16, 12),
  ciphertext: b64url(22, 2048),
});

export const PairingRead = z.object({
  status: z.enum(["pending", "delivered"]),
  pub: z.string().optional(),
  iv: z.string().optional(),
  ciphertext: z.string().optional(),
});

export const AccountStatus = z.enum(["connected", "reconnect_required"]);
export const GuestApp = z.enum(["ufba", "guest"]);
export const SourceName = z.enum(["sigaa", "moodle", "classroom"]);

// ---- sessão ----

export const CreateSessionBody = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectUri: z.string().min(1),
});

export const Me = z.object({
  id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  connections: z.object({
    sigaa: z.object({
      status: SigaaStatus,
      login: z.string().nullable(),
      /** Cópias mestras (passkeys) que guardam a senha do SIGAA para religar depois de sair. */
      passkey: z.object({ slots: z.number().int() }),
    }),
    moodle: z.object({
      status: z.union([AccountStatus, z.literal("disconnected")]),
      account: z.string().nullable(),
    }),
    classroom: z.object({
      available: z.boolean(),
      apps: z.array(GuestApp),
      accounts: z.array(z.object({ email: z.string(), status: AccountStatus })),
    }),
  }),
});

// ---- conexões ----

export const ConnectSigaaBody = z.object({
  /** CPF, 11 dígitos. */
  login: z.string().min(1),
  password: z.string().min(1),
});

export const MoodleStartResponse = z.object({
  launchUrl: z.string(),
  scheme: z.string(),
});

export const ConnectMoodleBody = z.object({
  /** Link capturado do AVA (esquema do app). */
  link: z.string().min(1),
});

export const ClassroomStartQuery = z.object({ app: GuestApp.optional() });

// ---- autorização de clientes ----

export const ClientView = z.object({
  domain: z.string(),
  redirectUri: z.string(),
  name: z.string().nullable(),
  logoUrl: z.string().nullable(),
  verified: z.boolean(),
  metadata: z.enum(["present", "absent"]),
});

export const RequestInfo = z.object({
  id: z.string(),
  client: ClientView,
  signedIn: z.boolean(),
  sources: z
    .array(
      z.object({
        source: SourceName,
        status: z.union([SigaaStatus, AccountStatus]),
      }),
    )
    .nullable(),
  expiresAt: z.string().datetime(),
});

export const RedirectResponse = z.object({ redirectTo: z.string() });

export const AuthorizedApp = ClientView.omit({
  redirectUri: true,
  metadata: true,
}).extend({
  clientId: z.string(),
  authorizedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  sigaa: z.boolean(),
});

export const AuthorizedAppsResponse = z.object({
  apps: z.array(AuthorizedApp),
});

// ---- memória compartilhada: dispositivo e computadores ----

/** Código que a pessoa viu no terminal (`XXXX-XXXX`; a API normaliza maiúsculas e hífen). */
export const DeviceCodeBody = z.object({ userCode: z.string().min(1).max(32) });

export const DeviceLookupResponse = z.object({
  clientName: z.string(),
  computerName: z.string().nullable(),
  os: z.string().nullable(),
  requestedAt: z.string().datetime(),
  /** Rede aproximada de quem pediu (ex.: "rede 200.128.x.x"); a API não guarda geolocalização. */
  approxLocation: z.string().nullable(),
  /** A rede de quem aprova é bem diferente da de quem pediu: a tela destaca o aviso. */
  ipDiffers: z.boolean(),
});

export const DeviceDecisionBody = z.object({
  userCode: z.string().min(1).max(32),
  decision: z.enum(["approve", "deny"]),
});

export const MemoryComputerView = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string(),
  agents: z.array(z.string()),
  installMode: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});

export const MemoryComputersResponse = z.object({
  computers: z.array(MemoryComputerView),
});

export const RenameComputerBody = z.object({ name: z.string().min(1).max(60) });

export const MemoryStatusResponse = z.object({
  memoryAvailable: z.boolean(),
  userReady: z.boolean(),
  isAdmin: z.boolean(),
  computers: z.array(MemoryComputerView),
});

// ---- memória compartilhada: Meus projetos ----

export const ProjectView = z.object({
  id: z.string(),
  workspace: z.string(),
  project: z.string(),
  title: z.string(),
  /** Projeto do time (sem dono; permissões vêm dos papéis). */
  team: z.boolean(),
  role: z.enum(["owner", "read", "write"]),
  source: z.enum(["owner", "invite", "team"]),
  membersCount: z.number().int(),
  /** `pending` = a memória ainda está sendo sincronizada (tentando de novo). */
  sync: z.enum(["ok", "pending"]),
});

export const ProjectsResponse = z.object({ projects: z.array(ProjectView) });

export const ProjectMember = z.object({
  email: z.string(),
  name: z.string().nullable(),
  level: z.enum(["read", "write"]),
  status: z.enum(["pending", "active"]),
});

export const ProjectDetail = ProjectView.extend({
  /** Só o dono recebe a lista; os demais recebem vazio. */
  members: z.array(ProjectMember),
  /** Trecho do `.ai-memory.toml` para colar na raiz do repositório. */
  marker: z.string(),
});

export const CreateProjectBody = z.object({ name: z.string().min(1).max(60) });
export const MemberLevelBody = z.object({ level: z.enum(["read", "write"]) });
export const TransferProjectBody = z.object({ email: z.string().min(3).max(200) });

// ---- memória compartilhada: Administração (só admin) ----

export const TeamRoleView = z.object({
  key: z.string(),
  description: z.string(),
  grants: z.array(
    z.object({
      workspace: z.string(),
      project: z.string(),
      title: z.string(),
      level: z.enum(["read", "write"]),
    }),
  ),
});

export const TeamMemberView = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
});

/** Tabela de papéis somente leitura (mudar é migração) e as pessoas com os papéis atribuídos. */
export const TeamResponse = z.object({
  roles: z.array(TeamRoleView),
  members: z.array(TeamMemberView),
});

export const TeamSearchQuery = z.object({ q: z.string().max(100).optional() });

export const TeamSearchResponse = z.object({ people: z.array(TeamMemberView) });

const CalendarIsoDate = z.string().describe("YYYY-MM-DD");
const CalendarRange = z.object({ start: CalendarIsoDate, end: CalendarIsoDate });
const CalendarOn = z.object({ type: z.literal("on"), date: CalendarIsoDate });
const CalendarBetween = z.object({ type: z.literal("between"), start: CalendarIsoDate, end: CalendarIsoDate });
const CalendarUndetermined = z.object({
  type: z.literal("undetermined"),
  reason: z.enum(["tbd", "anytime", "suspended", "see-link", "per-notice", "relative", "other"]),
  /** O texto impresso na coluna DATA. */
  text: z.string(),
});

export const CalendarQuery = z.object({ term: z.string().regex(/^\d{4}\.[12]$/).optional() });

/**
 * O calendário acadêmico publicado de um semestre (contrato fiel ao PDF da SUPAC, sem a conferência interna). Toda data é
 * ISO; textos como impressos. `when` é uma união: dia, intervalo, "até", "a partir de" ou sem data.
 */
export const PublishedCalendarResponse = z.object({
  contractVersion: z.literal("1"),
  /** De onde veio (PDF na SUPAC) e quando a API o publicou. */
  sourceUrl: z.string(),
  publishedAt: z.string().datetime(),
  document: z.object({ term: z.string(), publishedOn: CalendarIsoDate.nullable() }),
  keyDates: z.object({
    termStart: CalendarIsoDate,
    progress25: CalendarIsoDate,
    progress50: CalendarIsoDate,
    progress75: CalendarIsoDate,
    termEnd: CalendarIsoDate,
    internship: CalendarRange.nullable(),
  }),
  events: z.array(
    z.object({
      section: z.string(),
      procedure: z.string(),
      responsibles: z.array(z.string()),
      description: z.string(),
      when: z.discriminatedUnion("type", [
        CalendarOn,
        CalendarBetween,
        z.object({ type: z.literal("until"), date: CalendarIsoDate }),
        z.object({ type: z.literal("from"), date: CalendarIsoDate }),
        CalendarUndetermined,
      ]),
      /** Janelas extras do mesmo evento (reaberturas e dias soltos). */
      additionalWindows: z.array(CalendarRange),
      /** Data marcada com * (alteração de data). */
      dateChanged: z.boolean(),
      links: z.array(z.string()),
    }),
  ),
  teachingDays: z.object({
    byMonth: z.array(z.object({ month: z.string().describe("YYYY-MM"), days: z.number() })),
    total: z.number(),
  }),
  nonTeachingDays: z.array(
    z.object({
      name: z.string(),
      when: z.discriminatedUnion("type", [CalendarOn, CalendarBetween]),
      weekday: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).nullable(),
      dateChanged: z.boolean(),
    }),
  ),
  otherEvents: z.array(
    z.object({
      name: z.string(),
      when: z.discriminatedUnion("type", [CalendarOn, CalendarBetween, CalendarUndetermined]),
      links: z.array(z.string()),
    }),
  ),
});

/** Alertas do calendário acadêmico para os admins (sem o contrato completo: é grande). */
export const CalendarAlertsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
      sourceUrl: z.string(),
      /** "2026.2"; nulo quando a página inteira falhou. */
      term: z.string().nullable(),
      status: z.enum(["NOT_VERIFIED", "ERROR"]),
      /** Avisos da conferência (NOT_VERIFIED) ou o motivo do erro (ERROR). */
      warnings: z.array(z.string()),
      model: z.string().nullable(),
      inputTokens: z.number().int().nullable(),
      outputTokens: z.number().int().nullable(),
    }),
  ),
  /** O último calendário publicado já terminou e nada novo apareceu. */
  expired: z.object({ term: z.string(), termEnd: z.string() }).nullable(),
});

// ---- permissões por fonte (o que a pessoa libera para o Claude fazer) ----

/** Chaves das permissões (enum fechado, como API_ERROR_CODES): "<fonte>.<ação>". Chave nova precisa de texto em PERMISSION_CATALOG. */
export const PERMISSION_KEYS = ["siasb.schedule_write", "siasb.procedures_write"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PermissionView = z.object({
  key: z.enum(PERMISSION_KEYS),
  source: z.string(),
  /** pt-BR, vindos da API: a tela não escreve texto de permissão. */
  title: z.string(),
  description: z.string(),
  risk: z.enum(["low", "high"]),
  /** Sem linha no banco = desligada. */
  enabled: z.boolean(),
  /** A pessoa tem conexão com a fonte em qualquer estado (inclusive reconectar). */
  available: z.boolean(),
  unavailableReason: z.literal("source_not_connected").nullable(),
});
export const PermissionsResponse = z.object({ items: z.array(PermissionView) });
export const PermissionBody = z.object({ enabled: z.boolean() });

export const MemorySyncResponse = z.object({
  failing: z.array(
    z.object({
      name: z.string().nullable(),
      email: z.string().nullable(),
      attempts: z.number().int(),
      nextRunAt: z.string().datetime(),
      /** Só código/status (ex.: `unavailable:503`), nunca corpo de resposta. */
      lastError: z.string().nullable(),
    }),
  ),
  /** Projetos nos workspaces `ufba-*` que existem no memory e a ufba.app não conhece. */
  unknownProjects: z.array(z.object({ workspace: z.string(), project: z.string() })),
});

// ---- dados (leitura ao vivo) ----

export const AccountQuery = z.object({
  /** Qual conta usar quando a pessoa tem mais de uma na fonte. */
  account: z.string().optional(),
});

export const CoursesQuery = AccountQuery.extend({
  /** `true` inclui turmas arquivadas/antigas. */
  all: z.enum(["true", "false"]).optional(),
});

export const AttachmentQuery = AccountQuery.extend({
  ref: z.string().min(1),
  name: z.string().optional(),
});

export const AccountsResponse = z.object({
  accounts: z.array(
    z.object({
      source: SourceName,
      account: z.string(),
      status: AccountStatus,
    }),
  ),
});

export const Course = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  url: z.string().optional(),
});

export const Deadline = z.object({
  id: z.string(),
  title: z.string(),
  dueAt: z.string().datetime(),
  courseId: z.string().optional(),
  courseName: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});

export const Attachment = z.object({
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  /** Passe em `GET /sources/{source}/attachment?ref=`. */
  ref: z.string(),
});

export const ActivityType = z.enum([
  "assignment",
  "exam",
  "material",
  "forum",
  "announcement",
  "other",
]);

export const Activity = z.object({
  id: z.string(),
  type: ActivityType,
  title: z.string(),
  section: z.string().optional(),
  description: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  url: z.string().optional(),
  attachments: z.array(Attachment),
  links: z.array(z.string()).optional(),
  openInBrowser: z
    .array(z.object({ name: z.string(), url: z.string() }))
    .optional(),
  forumId: z.string().optional(),
});

export const Discussion = z.object({
  id: z.string(),
  title: z.string(),
  message: z.string().optional(),
  author: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  attachments: z.array(Attachment),
});

export const CoursesResponse = z.object({ courses: z.array(Course) });
export const DeadlinesResponse = z.object({ deadlines: z.array(Deadline) });
export const CourseResponse = z.object({
  courseId: z.string(),
  activities: z.array(Activity),
});
export const ForumResponse = z.object({
  forumId: z.string(),
  discussions: z.array(Discussion),
});
export const AnnouncementResponse = z.object({ announcement: Discussion });

// ---- tipos ----

export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
export type SigaaStatus = z.infer<typeof SigaaStatus>;
export type AccountStatus = z.infer<typeof AccountStatus>;
export type GuestApp = z.infer<typeof GuestApp>;
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;
export type Me = z.infer<typeof Me>;
export type ConnectSigaaBody = z.infer<typeof ConnectSigaaBody>;
export type ConnectMoodleBody = z.infer<typeof ConnectMoodleBody>;
export type ClientView = z.infer<typeof ClientView>;
export type RequestInfo = z.infer<typeof RequestInfo>;
export type AuthorizedApp = z.infer<typeof AuthorizedApp>;
export type Course = z.infer<typeof Course>;
export type Deadline = z.infer<typeof Deadline>;
export type Activity = z.infer<typeof Activity>;
export type Discussion = z.infer<typeof Discussion>;

/**
 * Valida a entrada contra o schema. Erro vira 400 genérico: a mensagem nunca ecoa o que veio (pode ser senha).
 */
export function parseInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  onError: () => Error,
): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw onError();
  return r.data;
}
