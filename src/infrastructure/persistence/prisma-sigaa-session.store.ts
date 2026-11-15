import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  SigaaSessionStore,
  type SigaaSessionKey,
  type SigaaSessionRecord,
} from '../../application/ports/repositories';
import { PrismaService } from './prisma.service';

/**
 * Sessão do SIGAA por pessoa no Postgres. A trava é um lease na própria linha, adquirido por um único comando
 * atômico (INSERT … ON CONFLICT DO UPDATE … WHERE vencida): não segura conexão do banco durante as chamadas ao SIGAA e
 * não deixa trava órfã se o processo morrer.
 */
@Injectable()
export class PrismaSigaaSessionStore extends SigaaSessionStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async acquire(key: SigaaSessionKey, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const secs = ttlMs / 1000;
    const rows = await this.prisma.$queryRaw<{ lock_token: string }[]>`
      INSERT INTO sigaa_sessions (id, user_id, login, lock_token, locked_until, updated_at)
      VALUES (gen_random_uuid(), ${key.userId}::uuid, ${key.login}, ${token}, now() + make_interval(secs => ${secs}::double precision), now())
      ON CONFLICT (user_id, login) DO UPDATE
        SET lock_token = EXCLUDED.lock_token, locked_until = EXCLUDED.locked_until, updated_at = now()
        WHERE sigaa_sessions.locked_until IS NULL OR sigaa_sessions.locked_until < now()
      RETURNING lock_token`;
    return rows.length ? token : null;
  }

  async release(key: SigaaSessionKey, token: string): Promise<void> {
    await this.prisma.sigaaSession.updateMany({
      where: { userId: key.userId, login: key.login, lockToken: token },
      data: { lockToken: null, lockedUntil: null },
    });
  }

  async load(key: SigaaSessionKey): Promise<SigaaSessionRecord | null> {
    const r = await this.prisma.sigaaSession.findUnique({
      where: { userId_login: { userId: key.userId, login: key.login } },
    });
    if (!r?.cookieCiphertext || !r.cookieIv || !r.cookieAuthTag || !r.lastUsedAt) return null;
    return {
      cookie: { ciphertext: r.cookieCiphertext, iv: r.cookieIv, authTag: r.cookieAuthTag },
      lastUsedAt: r.lastUsedAt.getTime(),
    };
  }

  async save(key: SigaaSessionKey, token: string, rec: SigaaSessionRecord): Promise<boolean> {
    const { count } = await this.prisma.sigaaSession.updateMany({
      where: { userId: key.userId, login: key.login, lockToken: token },
      data: {
        cookieCiphertext: rec.cookie.ciphertext,
        cookieIv: rec.cookie.iv,
        cookieAuthTag: rec.cookie.authTag,
        lastUsedAt: new Date(rec.lastUsedAt),
      },
    });
    return count > 0;
  }

  async delete(key: SigaaSessionKey, token: string): Promise<boolean> {
    const { count } = await this.prisma.sigaaSession.updateMany({
      where: { userId: key.userId, login: key.login, lockToken: token },
      data: { cookieCiphertext: null, cookieIv: null, cookieAuthTag: null, lastUsedAt: null },
    });
    return count > 0;
  }
}
