import type { EncryptedSecret } from '../ports/repositories';
import type { Secret } from '../shared/secret';

/** Credencial no ai-memory (metadados; o segredo só vem em `IssuedCredential`, uma vez). */
export interface MemoryCredential {
  id: string;
  /** id do usuário no memory (não é o `userId` da ufba.app). */
  memoryUserId: string;
  label: string;
  preview: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface IssuedCredential {
  credential: MemoryCredential;
  /** Aparece uma única vez; nunca vai para log, erro ou resposta sem passar por `reveal()` consciente. */
  token: Secret;
}

export interface MemoryUserInfo {
  id: string;
  username: string;
  name: string | null;
  disabled: boolean;
}

export type GrantLevel = 'read' | 'write';
export type ProjectAccessMode = 'restricted' | 'open';

export interface MemoryGrant {
  username: string;
  workspace: string;
  project: string;
  level: GrantLevel;
}

export interface MemoryProjectInfo {
  workspace: string;
  project: string;
}

export type MemoryErrorKind = 'unavailable' | 'conflict' | 'not_found' | 'forbidden' | 'rejected' | 'read_only' | 'no_access';

/**
 * Erro do ai-memory SEM corpo da resposta (pode conter segredo ou conteúdo de trabalho): só o tipo e o status HTTP.
 */
export class MemoryAdminError extends Error {
  constructor(
    readonly kind: MemoryErrorKind,
    readonly status?: number,
  ) {
    super(`memory ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'MemoryAdminError';
  }
}

/**
 * API administrativa do ai-memory (token root; só esta porta o usa). Nenhuma rota repassa caminho arbitrário: cada
 * operação abaixo é um método fixo.
 */
export abstract class MemoryAdmin {
  /** Há URL e token root configurados? Sem isso as ferramentas `memory_*` simplesmente não existem. */
  abstract isConfigured(): boolean;
  /** O servidor de memória responde (sem usar o token root). */
  abstract ping(): Promise<boolean>;
  /** Cria o usuário "humano" e DESCARTA a senha temporária. `created: false` se o username já existia. */
  abstract createHumanUser(input: { username: string; name?: string }): Promise<{ created: boolean }>;
  abstract findUser(username: string): Promise<MemoryUserInfo | null>;
  abstract renameUser(username: string, name: string): Promise<void>;
  /** Atenção: `disable` NÃO invalida chaves `aim_` (spike S2); revogue as credenciais antes. */
  abstract disableUser(username: string): Promise<void>;
  abstract issueCredential(username: string, label: string): Promise<IssuedCredential>;
  abstract rotateCredential(credentialId: string): Promise<IssuedCredential>;
  abstract revokeCredential(credentialId: string): Promise<void>;
  abstract listCredentials(username: string): Promise<MemoryCredential[]>;
  abstract setProjectAccess(workspace: string, project: string, mode: ProjectAccessMode): Promise<void>;
  abstract grant(username: string, workspace: string, project: string, level: GrantLevel): Promise<void>;
  abstract revokeGrant(username: string, workspace: string, project: string): Promise<void>;
  abstract listGrants(username: string): Promise<MemoryGrant[]>;
  abstract listProjects(): Promise<MemoryProjectInfo[]>;
  /** Apaga páginas e arquivos do projeto (destrutivo). */
  abstract purgeProject(workspace: string, project: string): Promise<void>;
}

export interface MemoryUserRecord {
  userId: string;
  memoryUsername: string;
  status: 'creating' | 'ready' | 'disabled';
  proxyCredentialId: string | null;
  proxyKey: EncryptedSecret | null;
  displayName: string | null;
}

export abstract class MemoryUserRepository {
  abstract find(userId: string): Promise<MemoryUserRecord | null>;
  /** Cria a linha `creating` se não existir (idempotente) e devolve a linha atual. */
  abstract createIfAbsent(input: { userId: string; memoryUsername: string }): Promise<MemoryUserRecord>;
  /**
   * Grava a chave de repasse só se ainda não houver uma (corrida entre duas chamadas). `false` = outra chamada
   * ganhou; quem perdeu deve revogar a credencial que criou.
   */
  abstract saveProxyIfAbsent(
    userId: string,
    input: { credentialId: string; key: EncryptedSecret; displayName: string | null },
  ): Promise<boolean>;
  abstract markReady(userId: string): Promise<void>;
}

/** Ferramenta como o /mcp do ai-memory a descreve. */
export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Resultado de `tools/call`, repassado sem alterar. */
export interface RemoteToolResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Cliente do /mcp do ai-memory com a CHAVE DA PESSOA (nunca a root). Erros sem corpo: só `MemoryAdminError`
 * (`unavailable` para queda/timeout/protocolo; `forbidden` para 401/403 da chave).
 */
export abstract class MemoryMcp {
  abstract listTools(key: Secret): Promise<RemoteTool[]>;
  abstract callTool(key: Secret, name: string, args: Record<string, unknown>): Promise<RemoteToolResult>;
}

/** Projetos que o proxy aceita (S12): só `workspace/projeto` registrado. Hoje o conjunto semeado; a etapa 7 usa o banco. */
export abstract class MemoryProjectRegistry {
  abstract isRegistered(workspace: string, project: string): Promise<boolean>;
}

/** Quem pode usar a memória pela ufba.app. A etapa 8 troca a implementação aberta pelos papéis do time. */
export abstract class MemoryAccess {
  abstract canUse(userId: string): Promise<boolean>;
}
