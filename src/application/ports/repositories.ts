import type {
  FetchedCourseSpace,
  FetchedEvent,
  FetchedGrade,
  FetchedItem,
  FetchedProfile,
  ItemKind,
  Provider,
} from './source-gateway';

/** Segredo cifrado (AES-256-GCM). Nunca existe para SIGAA. */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

// ── Identidade ──────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  name: string | null;
  createdAt: Date;
}

export abstract class UserRepository {
  abstract create(input: { name?: string }): Promise<UserRecord>;
  abstract findById(id: string): Promise<UserRecord | null>;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
}

export abstract class ApiKeyRepository {
  abstract create(input: {
    userId: string;
    keyHash: string;
    prefix: string;
    label?: string;
  }): Promise<ApiKeyRecord>;
  /** Só chaves não revogadas. */
  abstract findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  abstract touch(id: string, at: Date): Promise<void>;
}

export interface SourceAccountRecord {
  id: string;
  userId: string;
  provider: Provider;
  accountKey: string;
  siteUrl: string | null;
  status: 'OK' | 'REAUTH_NEEDED' | 'BLOCKED';
  lastSyncedAt: Date | null;
  /** Presente só para contas com token guardado. */
  secret: EncryptedSecret | null;
}

export interface UpsertSourceAccountInput {
  userId: string;
  provider: Provider;
  accountKey: string;
  siteUrl?: string;
  /** Proibido para SIGAA: o caso de uso rejeita antes de chegar aqui. */
  secret?: EncryptedSecret;
}

export abstract class SourceAccountRepository {
  abstract upsert(input: UpsertSourceAccountInput): Promise<SourceAccountRecord>;
  abstract findByUserAndProvider(
    userId: string,
    provider: Provider,
  ): Promise<SourceAccountRecord[]>;
  abstract listByUser(userId: string): Promise<SourceAccountRecord[]>;
  abstract setStatus(
    id: string,
    status: SourceAccountRecord['status'],
    reason?: string,
  ): Promise<void>;
  abstract markSynced(id: string, at: Date): Promise<void>;
  abstract saveProfile(userId: string, profile: FetchedProfile): Promise<void>;
}

// ── Sincronização (escrita) ─────────────────────────────────────────────────

export type EntityType =
  | 'COURSE_SPACE'
  | 'ITEM'
  | 'GRADE_ENTRY'
  | 'CALENDAR_EVENT';

/** O que o banco já conhece de uma entidade da conta, para `detectChanges`. `externalId` é a chave natural composta. */
export interface StoredHash {
  externalId: string;
  contentHash: string;
}

export interface SyncRunRecord {
  id: string;
  startedAt: Date;
}

export interface SyncCounts {
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
}

/** Lote já classificado pelo caso de uso. Os `hash` são `contentHash` do domínio. */
export interface SyncBatch<T> {
  created: Array<{ data: T; hash: string }>;
  updated: Array<{ data: T; hash: string }>;
  unchanged: Array<{ data: T }>;
  /** Chaves naturais (mesma forma de `StoredHash.externalId`) ausentes na fonte. */
  removed: string[];
}

export abstract class SyncRepository {
  abstract startRun(input: {
    sourceAccountId: string;
    scope: 'ALL' | 'COURSE' | 'ITEM';
    scopeRef?: string;
  }): Promise<SyncRunRecord>;
  abstract finishRun(
    runId: string,
    result:
      | { ok: true; counts: SyncCounts }
      | { ok: false; errorCode: string; errorMessage: string },
  ): Promise<void>;

  /** Hashes existentes (não removidos), restritos ao alcance. */
  abstract storedHashes(
    sourceAccountId: string,
    entity: EntityType,
    scopeCourseExternalId?: string,
  ): Promise<StoredHash[]>;

  /** Grava tudo numa transação: upserts, remoção lógica, `lastSeenAt` e ChangeEvents. */
  abstract apply(input: {
    sourceAccountId: string;
    runId: string;
    courseSpaces?: SyncBatch<FetchedCourseSpace>;
    items?: SyncBatch<FetchedItem>;
    events?: SyncBatch<FetchedEvent>;
    grades?: SyncBatch<FetchedGrade>;
  }): Promise<void>;
}

// ── Leitura (só banco) ──────────────────────────────────────────────────────

/** Metadados de um anexo (o conteúdo só sai por `ler_anexo`, sob demanda). */
export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface ItemView {
  id: string;
  provider: Provider;
  courseSpaceId: string;
  courseName: string;
  kind: ItemKind;
  title: string;
  body: string | null;
  dueAt: Date | null;
  publishedAt: Date | null;
  state: string | null;
  attachments?: AttachmentView[];
  lastSeenAt: Date;
}

export interface EventView {
  id: string;
  title: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  lastSeenAt: Date;
}

export interface ChangeView {
  id: string;
  entityType: EntityType;
  entityId: string;
  change: 'CREATED' | 'UPDATED' | 'REMOVED';
  summary: string | null;
  occurredAt: Date;
}

export interface CourseSpaceView {
  id: string;
  provider: Provider;
  externalId: string;
  name: string;
  lastSeenAt: Date;
}

export interface ItemFilter {
  userId: string;
  provider?: Provider;
  courseSpaceId?: string;
  kind?: ItemKind;
  dueFrom?: Date;
  dueTo?: Date;
  limit?: number;
}

export interface ProfileView {
  name: string | null;
  registration: string | null;
  programName: string | null;
  entryTerm: string | null;
  accounts: Array<{
    provider: Provider;
    status: string;
    lastSyncedAt: Date | null;
  }>;
}

export abstract class ReadRepository {
  abstract listCourseSpaces(userId: string): Promise<CourseSpaceView[]>;
  abstract listItems(filter: ItemFilter): Promise<ItemView[]>;
  abstract listEvents(input: {
    userId: string;
    from: Date;
    to: Date;
  }): Promise<EventView[]>;
  abstract listChanges(input: {
    userId: string;
    since: Date;
    limit?: number;
  }): Promise<ChangeView[]>;
  abstract getProfile(userId: string): Promise<ProfileView | null>;
  /** Histórico acadêmico (Transcript). `null` se nunca importado. */
  abstract getTranscript(
    userId: string,
  ): Promise<{ importedAt: Date; data: unknown } | null>;
}
