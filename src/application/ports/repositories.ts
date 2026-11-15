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
  /** Quando a conexão vence; nulo = não vence. */
  expiresAt: Date | null;
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
  expiresAt?: Date;
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
  /** Troca o token guardado (renovação) e, se vier, o vencimento. */
  abstract updateSecret(id: string, secret: EncryptedSecret, expiresAt?: Date): Promise<void>;
  /** Desconectar: apaga a conta e o token guardado. */
  abstract delete(id: string): Promise<void>;
}

// ── Cópia da DK por cliente OAuth / sessão do painel (a senha fica no cofre `SigaaVaultRepository`) ─────────────

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
  /** Apaga as cópias da DK de todos os clientes da pessoa, menos `clientId` (a DK velha não vale mais). */
  abstract deleteAllExcept(userId: string, clientId: string): Promise<void>;
  /** Apaga todas as cópias da DK da pessoa. */
  abstract deleteAllOf(userId: string): Promise<void>;
  /** Entre as cópias cujo `clientId` começa por `prefix`, mantém só as `keep` mais novas. */
  abstract pruneOldest(userId: string, clientIdPrefix: string, keep: number): Promise<void>;
}

/** Cofre da senha do SIGAA, um por pessoa: a senha cifrada com a DK (que nunca é guardada em claro). */
export interface SigaaVaultRecord {
  userId: string;
  login: string;
  secret: EncryptedSecret;
  status: 'OK' | 'REAUTH_NEEDED';
  version: number;
  updatedAt: Date;
}

export abstract class SigaaVaultRepository {
  abstract find(userId: string): Promise<SigaaVaultRecord | null>;
  /** Cria ou troca o cofre; a troca sobe `version` e volta o status para OK. */
  abstract upsert(input: { userId: string; login: string; secret: EncryptedSecret }): Promise<void>;
  abstract setStatus(userId: string, status: 'OK' | 'REAUTH_NEEDED'): Promise<void>;
  abstract delete(userId: string): Promise<void>;
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

// ── Sessão do SIGAA por pessoa (cookie cifrado + trava) ─────────────────────

export interface SigaaSessionKey {
  userId: string;
  /** Login do SIGAA (CPF), em minúsculas. */
  login: string;
}

export interface SigaaSessionRecord {
  cookie: EncryptedSecret;
  lastUsedAt: number;
}

/**
 * Guarda a sessão do SIGAA (só o cookie, cifrado) por pessoa e a TRAVA que serializa as consultas dela entre
 * instâncias do servidor. A trava é um lease: `acquire` devolve um token ou `null` se outra execução a detém e ela
 * ainda não venceu; vence sozinha (processo que morreu não prende ninguém). `save`/`delete` só valem para quem ainda
 * detém o token (devolvem `false` se a trava foi perdida).
 */
export abstract class SigaaSessionStore {
  abstract acquire(key: SigaaSessionKey, ttlMs: number): Promise<string | null>;
  abstract release(key: SigaaSessionKey, token: string): Promise<void>;
  abstract load(key: SigaaSessionKey): Promise<SigaaSessionRecord | null>;
  abstract save(key: SigaaSessionKey, token: string, rec: SigaaSessionRecord): Promise<boolean>;
  abstract delete(key: SigaaSessionKey, token: string): Promise<boolean>;
}

/** Cópia mestra da senha do SIGAA (cifrada no navegador com o PRF de uma passkey). O servidor só guarda e devolve. */
export interface SigaaMasterSlotRecord {
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
  label: string | null;
  createdAt: Date;
  lastUnlockedAt: Date | null;
}

export abstract class SigaaMasterSlotRepository {
  abstract list(userId: string): Promise<SigaaMasterSlotRecord[]>;
  abstract count(userId: string): Promise<number>;
  abstract find(userId: string, credentialId: string): Promise<SigaaMasterSlotRecord | null>;
  /** Cria ou troca a cópia desta passkey (mesma `credentialId` = a pessoa gravou de novo). */
  abstract upsert(userId: string, slot: Omit<SigaaMasterSlotRecord, 'createdAt' | 'lastUnlockedAt'>): Promise<void>;
  abstract touch(userId: string, credentialId: string, at: Date): Promise<void>;
  /** `false` se não existia. */
  abstract delete(userId: string, credentialId: string): Promise<boolean>;
  abstract deleteAll(userId: string): Promise<void>;
}

/** Pacote do celular para o computador: chave pública efêmera, iv e texto cifrado (AES-GCM), todos base64url. */
export interface SigaaPairingPacket {
  pub: string;
  iv: string;
  ciphertext: string;
}

/** Pedido do "correio" do QR (ver `SigaaPairings`). O pacote só existe depois da entrega do celular. */
export interface SigaaPairingRecord {
  id: string;
  userId: string;
  /** O que o COMPUTADOR diz de si: não é confiável. */
  label: string | null;
  client: string | null;
  /** O que a API VIU ao receber o pedido (User-Agent). */
  seenBrowser: string | null;
  seenOs: string | null;
  createdAt: Date;
  expiresAt: Date;
  packet: SigaaPairingPacket | null;
}

export abstract class SigaaPairingRepository {
  abstract create(rec: Omit<SigaaPairingRecord, 'packet'>): Promise<void>;
  /** Pedido do dono que ainda não venceu; `null` se não existe, venceu ou é de outra pessoa. */
  abstract find(id: string, userId: string, now: Date): Promise<SigaaPairingRecord | null>;
  /** Grava o pacote uma única vez: `false` se já havia pacote, venceu, não existe ou é de outra pessoa. */
  abstract deliver(id: string, userId: string, packet: SigaaPairingPacket, now: Date): Promise<boolean>;
  /** Lê E apaga o pedido entregue (uma leitura só): `null` se não há pacote ou outra leitura chegou antes. */
  abstract take(id: string, userId: string, now: Date): Promise<SigaaPairingPacket | null>;
  /** Pedidos abertos (não vencidos) da pessoa. */
  abstract countOpen(userId: string, now: Date): Promise<number>;
  abstract deleteExpired(now: Date): Promise<void>;
}
