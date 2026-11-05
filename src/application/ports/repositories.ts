import type { Provider } from './source-gateway';

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

// ── Contas conectadas (só o acesso; o conteúdo das fontes não é gravado) ─────

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
}

// ── Credencial do SIGAA cifrada por cliente OAuth ─────────────────────────────

export interface SigaaCredentialRecord {
  id: string;
  userId: string;
  clientId: string;
  login: string;
  secret: EncryptedSecret;
  status: 'OK' | 'REAUTH_NEEDED';
  createdAt: Date;
}

export abstract class SigaaCredentialRepository {
  abstract upsert(input: {
    userId: string;
    clientId: string;
    login: string;
    secret: EncryptedSecret;
  }): Promise<SigaaCredentialRecord>;
  abstract find(userId: string, clientId: string): Promise<SigaaCredentialRecord | null>;
  abstract setStatus(id: string, status: 'OK' | 'REAUTH_NEEDED'): Promise<void>;
}
