/** Estados do login de dispositivo (RFC 8628) e do token curto. */
export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'issued' | 'consumed';

export interface DeviceAuthorizationRecord {
  deviceCodeHash: string;
  userCodeHash: string;
  clientId: string;
  scope: string;
  computerName: string | null;
  os: string | null;
  requestIp: string | null;
  status: DeviceStatus;
  userId: string | null;
  intervalSec: number;
  lastPolledAt: Date | null;
  pollCount: number;
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Tudo condicional e atômico onde importa (duas chamadas simultâneas: só uma ganha). Só hashes entram aqui. */
export abstract class DeviceAuthorizationRepository {
  /** false se `userCodeHash` já existe (o serviço sorteia outro código). */
  abstract create(rec: DeviceAuthorizationRecord): Promise<boolean>;
  abstract findByDeviceHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  abstract findByUserHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  abstract findByTokenHash(hash: string): Promise<DeviceAuthorizationRecord | null>;
  /** Pedidos ainda válidos (não expirados, não terminados) desse IP. */
  abstract countActiveByIp(ip: string, now: Date): Promise<number>;
  abstract touchPoll(hash: string, v: { lastPolledAt: Date; intervalSec: number; pollCount: number }): Promise<void>;
  /** pending e não expirado → approved/denied, ligado a `userId`. */
  abstract decide(userHash: string, userId: string, status: 'approved' | 'denied', now: Date): Promise<boolean>;
  /** approved e não expirado → issued, com o hash do token curto. */
  abstract issueToken(deviceHash: string, tokenHash: string, tokenExpiresAt: Date, now: Date): Promise<boolean>;
  /** issued e token não expirado → consumed. */
  abstract consume(deviceHash: string, now: Date): Promise<boolean>;
  abstract deleteExpired(before: Date): Promise<void>;
}

export interface MemoryComputerRecord {
  id: string;
  userId: string;
  name: string;
  os: string;
  credentialId: string;
  keyPreview: string | null;
  agents: string[];
  clientVersion: string | null;
  installMode: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export abstract class MemoryComputerRepository {
  abstract insert(rec: MemoryComputerRecord): Promise<void>;
  abstract find(id: string): Promise<MemoryComputerRecord | null>;
  /** Do mais novo ao mais antigo; inclui revogados (a tela os mostra). */
  abstract listForUser(userId: string): Promise<MemoryComputerRecord[]>;
  abstract countActive(userId: string): Promise<number>;
  /** Reinstalação: troca a credencial e zera a confirmação (a chave nova ainda não foi gravada). */
  abstract reissue(
    id: string,
    v: {
      credentialId: string;
      keyPreview: string | null;
      name: string;
      os: string;
      agents: string[];
      clientVersion: string | null;
      installMode: string | null;
      at: Date;
    },
  ): Promise<void>;
  abstract confirm(id: string, userId: string, at: Date): Promise<boolean>;
  abstract rename(id: string, userId: string, name: string): Promise<boolean>;
  abstract markRevoked(id: string, at: Date): Promise<void>;
  /** Emitidos e nunca confirmados, anteriores a `before`, ainda não revogados (opcionalmente de uma pessoa). */
  abstract listUnconfirmed(before: Date, userId?: string): Promise<MemoryComputerRecord[]>;
}

/** Computadores ativos da pessoa, como o `memory_status` precisa. */
export abstract class MemoryComputerDirectory {
  abstract active(userId: string): Promise<{ name: string; os: string; lastSeen: Date | null }[]>;
}
