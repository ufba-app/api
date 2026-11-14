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
  "role_not_found",
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
]);
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
    sigaa: z.object({ status: SigaaStatus, login: z.string().nullable() }),
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
