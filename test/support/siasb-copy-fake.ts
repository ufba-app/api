import {
  SiasbCopyRepository,
  type SyncedAttendance,
  type SyncedSession,
  type SyncResult,
  type SyncState,
} from '../../src/application/ports/siasb-copy';

type Stored = SyncState & { lockedUntil: Date | null };

/** Cópia do SIASB em memória (mesma semântica do Postgres). `accounts` simula a conta SIASB de cada pessoa. */
export class InMemorySiasbCopy extends SiasbCopyRepository {
  accounts = new Map<string, 'OK' | 'REAUTH_NEEDED'>();
  private attendanceRows = new Map<string, Map<string, SyncedAttendance>>();
  private sessionRows = new Map<string, Map<string, SyncedSession>>();
  private states = new Map<string, Stored>();

  async replaceWindow(
    userId: string,
    window: { from: Date; to: Date },
    data: { attendances: SyncedAttendance[]; sessions: SyncedSession[] },
  ): Promise<boolean> {
    if (!this.accounts.has(userId)) return false;
    this.attendanceRows.set(userId, new Map(data.attendances.map((a) => [a.id, { ...a }])));
    const sessions = this.sessionRows.get(userId) ?? new Map<string, SyncedSession>();
    for (const [id, s] of sessions) {
      if (s.startAt >= window.from && s.startAt <= window.to) sessions.delete(id);
    }
    for (const s of data.sessions) sessions.set(s.id, { ...s });
    this.sessionRows.set(userId, sessions);
    return true;
  }

  async sessions(userId: string, from: Date, to: Date): Promise<SyncedSession[]> {
    return [...(this.sessionRows.get(userId)?.values() ?? [])]
      .filter((s) => s.startAt >= from && s.startAt <= to)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }

  async attendances(userId: string): Promise<SyncedAttendance[]> {
    return [...(this.attendanceRows.get(userId)?.values() ?? [])];
  }

  async deleteAll(userId: string): Promise<void> {
    this.attendanceRows.delete(userId);
    this.sessionRows.delete(userId);
    this.states.delete(userId);
  }

  async state(userId: string): Promise<SyncState | null> {
    const s = this.states.get(userId);
    if (!s) return null;
    return {
      lastAttemptAt: s.lastAttemptAt,
      lastSuccessAt: s.lastSuccessAt,
      result: s.result,
      nextRunAt: s.nextRunAt,
    };
  }

  private ensure(userId: string): Stored {
    let s = this.states.get(userId);
    if (!s) {
      s = {
        lastAttemptAt: null,
        lastSuccessAt: null,
        result: null,
        nextRunAt: null,
        lockedUntil: null,
      };
      this.states.set(userId, s);
    }
    return s;
  }

  async recordAttempt(userId: string, r: { result: SyncResult; at: Date; nextRunAt: Date | null }): Promise<void> {
    const s = this.ensure(userId);
    s.lastAttemptAt = r.at;
    s.result = r.result;
    s.nextRunAt = r.nextRunAt;
    if (r.result === 'OK') s.lastSuccessAt = r.at;
  }

  async claim(userId: string, now: Date, leaseMs: number): Promise<boolean> {
    const s = this.ensure(userId);
    if (s.lockedUntil && s.lockedUntil >= now) return false;
    s.lockedUntil = new Date(now.getTime() + leaseMs);
    return true;
  }

  async release(userId: string): Promise<void> {
    const s = this.states.get(userId);
    if (s) s.lockedUntil = null;
  }

  async dueUsers(now: Date, limit: number): Promise<string[]> {
    const due: { userId: string; at: number }[] = [];
    for (const [userId, status] of this.accounts) {
      if (status !== 'OK') continue;
      const s = this.states.get(userId);
      if (!s) due.push({ userId, at: -Infinity });
      else if (!s.nextRunAt) due.push({ userId, at: -Infinity });
      else if (s.nextRunAt <= now) due.push({ userId, at: s.nextRunAt.getTime() });
    }
    return due
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((d) => d.userId);
  }
}
