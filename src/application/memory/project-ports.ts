import type { GrantLevel } from './memory-ports';

export interface ProjectRecord {
  id: string;
  workspace: string;
  project: string;
  title: string;
  /** Nulo = projeto do time. */
  ownerId: string | null;
  createdAt: Date;
}

export type MemberStatus = 'pending' | 'active';

export interface MemberRecord {
  projectId: string;
  email: string;
  userId: string | null;
  level: GrantLevel;
  status: MemberStatus;
  invitedBy: string | null;
  createdAt: Date;
}

export abstract class MemoryProjectRepository {
  /** false se `workspace/project` já existe (o serviço sorteia outro sufixo). */
  abstract insert(p: ProjectRecord): Promise<boolean>;
  abstract find(id: string): Promise<ProjectRecord | null>;
  abstract findByCoordinates(workspace: string, project: string): Promise<ProjectRecord | null>;
  /** Todos os projetos conhecidos (o reconciliador precisa do conjunto gerenciado). */
  abstract listAll(): Promise<ProjectRecord[]>;
  /** Projetos em que a pessoa é dona ou membro ativo. */
  abstract listForUser(userId: string): Promise<ProjectRecord[]>;
  abstract listOwnedBy(userId: string): Promise<ProjectRecord[]>;
  abstract titleTakenBy(ownerId: string, title: string): Promise<boolean>;
  abstract delete(id: string): Promise<void>;
  abstract setOwner(id: string, ownerId: string): Promise<void>;

  abstract listMembers(projectId: string): Promise<MemberRecord[]>;
  abstract findMember(projectId: string, email: string): Promise<MemberRecord | null>;
  abstract upsertMember(m: MemberRecord): Promise<void>;
  abstract deleteMember(projectId: string, email: string): Promise<void>;
  /** Todas as linhas de membro da pessoa (por conta ou por e-mail pendente). */
  abstract listMembershipsOf(userId: string): Promise<MemberRecord[]>;
  abstract listPendingByEmail(email: string): Promise<MemberRecord[]>;
  abstract bindMember(projectId: string, email: string, userId: string): Promise<void>;
  /** Pessoas com algum acesso dado por esta tabela (donas e membros ativos): quem a varredura reconcilia. */
  abstract listInvolvedUserIds(): Promise<string[]>;
}

export interface SyncJobRecord {
  userId: string;
  attempts: number;
  nextRunAt: Date;
  lastError: string | null;
}

export abstract class MemorySyncJobRepository {
  /** Cria ou atualiza o job da pessoa. */
  abstract schedule(userId: string, attempts: number, nextRunAt: Date, lastError: string | null): Promise<void>;
  abstract clear(userId: string): Promise<void>;
  abstract find(userId: string): Promise<SyncJobRecord | null>;
  abstract listDue(now: Date, limit: number): Promise<SyncJobRecord[]>;
  abstract listAll(limit: number): Promise<SyncJobRecord[]>;
}

/** Concessões que vêm dos papéis do time (etapa 8). Vazio até lá. */
export abstract class TeamGrantSource {
  abstract grantsFor(userId: string): Promise<{ projectId: string; level: GrantLevel }[]>;
  /** Pessoas que têm algum papel (a varredura também as reconcilia). */
  abstract involvedUserIds(): Promise<string[]>;
}

/** Quem chama o reconciliador (o proxy do MCP, a cada uso, com limitação). */
export abstract class MemoryGrantSync {
  abstract syncUser(userId: string): Promise<boolean>;
}
