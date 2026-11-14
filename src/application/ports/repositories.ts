import type { BoundSource, SourceSubject } from '../../domain/identity/source-binding';
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
  /** Desconectar: apaga a conta e o token guardado. */
  abstract delete(id: string): Promise<void>;
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
  abstract delete(userId: string, clientId: string): Promise<void>;
}

// ── Vínculo fixo conta ↔ titular na fonte (domain/identity/source-binding) ───

export abstract class SourceBindingRepository {
  /** Hash do titular a que esta conta está ligada nesta fonte. */
  abstract findMine(userId: string, source: BoundSource): Promise<string | null>;
  /** Conta do ufba.app dona deste titular. */
  abstract findOwner(source: BoundSource, subjectHash: string): Promise<string | null>;
  /** Cria o vínculo. `false` se outro vínculo chegou antes (unicidade nos dois sentidos). */
  abstract create(userId: string, source: BoundSource, subjectHash: string): Promise<boolean>;
}

/** Transforma o titular (CPF, usuário do AVA) num hash estável e não reversível sem a chave do servidor. */
export abstract class SubjectHasher {
  abstract hash(subject: SourceSubject): string;
}
