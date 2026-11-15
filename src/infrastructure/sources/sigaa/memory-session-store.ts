import { randomUUID } from 'node:crypto';
import {
  SigaaSessionStore,
  type SigaaSessionKey,
  type SigaaSessionRecord,
} from '../../../application/ports/repositories';

interface Linha {
  rec?: SigaaSessionRecord;
  token?: string;
  ate?: number;
}

const id = (k: SigaaSessionKey) => `${k.userId}:${k.login}`;

/** Store em memória: testes e desenvolvimento sem banco. Mesma semântica de trava do store do Postgres. */
export class MemorySigaaSessionStore extends SigaaSessionStore {
  private readonly linhas = new Map<string, Linha>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  acquire(key: SigaaSessionKey, ttlMs: number): Promise<string | null> {
    const l = this.linhas.get(id(key)) ?? {};
    if (l.token && l.ate !== undefined && l.ate > this.now()) return Promise.resolve(null);
    const token = randomUUID();
    this.linhas.set(id(key), { rec: l.rec, token, ate: this.now() + ttlMs });
    return Promise.resolve(token);
  }

  release(key: SigaaSessionKey, token: string): Promise<void> {
    const l = this.linhas.get(id(key));
    if (l?.token === token) this.linhas.set(id(key), { rec: l.rec });
    return Promise.resolve();
  }

  load(key: SigaaSessionKey): Promise<SigaaSessionRecord | null> {
    return Promise.resolve(this.linhas.get(id(key))?.rec ?? null);
  }

  save(key: SigaaSessionKey, token: string, rec: SigaaSessionRecord): Promise<boolean> {
    const l = this.linhas.get(id(key));
    if (l?.token !== token) return Promise.resolve(false);
    l.rec = rec;
    return Promise.resolve(true);
  }

  delete(key: SigaaSessionKey, token: string): Promise<boolean> {
    const l = this.linhas.get(id(key));
    if (l?.token !== token) return Promise.resolve(false);
    l.rec = undefined;
    return Promise.resolve(true);
  }
}
