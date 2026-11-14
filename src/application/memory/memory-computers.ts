import { randomUUID } from 'node:crypto';
import type { Secret } from '../shared/secret';
import { ApiError } from '../web/web-api';
import { asOs, cleanName } from './device-authorizations';
import { MemoryComputerDirectory, MemoryComputerRecord, MemoryComputerRepository } from './device-ports';
import { MemoryAdmin, MemoryAdminError } from './memory-ports';
import { MemoryUsers } from './memory-users';
import { RateWindow } from './rate-window';

export const MAX_ACTIVE_COMPUTERS = 10;
export const UNCONFIRMED_TTL_MS = 10 * 60_000;
const MAX_AGENTS = 20;

export interface CreateComputerInput {
  name?: unknown;
  os?: unknown;
  computerId?: unknown;
  agents?: unknown;
  clientVersion?: unknown;
  installMode?: unknown;
}

export interface CreatedComputer {
  computerId: string;
  username: string;
  /** Aparece uma única vez, na resposta (HTTPS, `no-store`); nunca em log. */
  key: Secret;
}

export interface ComputerView {
  id: string;
  name: string;
  os: string;
  agents: string[];
  installMode: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailable(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(503, 'memory_unavailable', 'A memória está indisponível no momento. Tente de novo em instantes.');
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => cleanName(x, 40))
    .filter((x): x is string => Boolean(x))
    .slice(0, MAX_AGENTS);
}

/**
 * Computadores conectados: uma chave `aim_` por computador, emitida no ai-memory e entregue uma única vez ao
 * instalador. A API guarda só o id da credencial e a prévia, nunca a chave. A chave só vale depois que o instalador
 * confirma que a gravou; sem confirmação em 10 minutos a varredura a revoga (correção 1 do spike).
 */
export class MemoryComputers extends MemoryComputerDirectory {
  private readonly creates: RateWindow;

  constructor(
    private readonly admin: MemoryAdmin,
    private readonly users: MemoryUsers,
    private readonly repo: MemoryComputerRepository,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.creates = new RateWindow(5, 60 * 60_000, this.now);
  }

  /** Cria um computador novo ou, com `computerId` conhecido da mesma pessoa, troca a chave dele (reinstalação/repetição). */
  async create(userId: string, input: CreateComputerInput): Promise<CreatedComputer> {
    if (!this.creates.take(userId)) {
      throw new ApiError(429, 'too_many_attempts', 'Muitas conexões de computador em pouco tempo. Tente mais tarde.');
    }
    const name = cleanName(input.name) ?? 'computador';
    const os = asOs(input.os);
    if (!os) throw new ApiError(400, 'invalid_request', 'Sistema operacional inválido.');
    const fields = {
      name,
      os,
      agents: strList(input.agents),
      clientVersion: cleanName(input.clientVersion, 40),
      installMode: input.installMode === 'fresh' || input.installMode === 'profile' ? input.installMode : null,
    };

    try {
      await this.sweep(userId);
      const { username } = await this.users.ensure(userId);
      const wanted = typeof input.computerId === 'string' && UUID.test(input.computerId) ? input.computerId.toLowerCase() : null;
      const known = wanted ? await this.repo.find(wanted) : null;
      if (known && known.userId === userId && !known.revokedAt) {
        const rotated = await this.admin.rotateCredential(known.credentialId);
        await this.repo.reissue(known.id, {
          credentialId: rotated.credential.id,
          keyPreview: rotated.credential.preview || null,
          ...fields,
          at: new Date(this.now()),
        });
        return { computerId: known.id, username, key: rotated.token };
      }

      if ((await this.repo.countActive(userId)) >= MAX_ACTIVE_COMPUTERS) {
        throw new ApiError(
          409,
          'computer_limit_reached',
          `Você já tem ${MAX_ACTIVE_COMPUTERS} computadores conectados. Remova um para conectar outro.`,
        );
      }
      // O id gerado pelo instalador vale também na criação (a primeira chamada passa a ser idempotente: se a resposta
      // se perder, repetir com o mesmo id troca a chave em vez de criar outro computador). Id de outra pessoa é ignorado.
      const id = wanted && !known ? wanted : randomUUID();
      const issued = await this.admin.issueCredential(username, `pc:${id.slice(0, 8)}:${name}`);
      try {
        await this.repo.insert({
          id,
          userId,
          ...fields,
          credentialId: issued.credential.id,
          keyPreview: issued.credential.preview || null,
          createdAt: new Date(this.now()),
          confirmedAt: null,
          lastSeenAt: null,
          revokedAt: null,
        });
      } catch (e) {
        await this.admin.revokeCredential(issued.credential.id).catch(() => undefined);
        throw e;
      }
      return { computerId: id, username, key: issued.token };
    } catch (e) {
      throw unavailable(e);
    }
  }

  /** O instalador gravou a chave: o computador passa a valer. */
  async confirm(userId: string, computerId: string): Promise<boolean> {
    return this.repo.confirm(computerId, userId, new Date(this.now()));
  }

  /** Confirmados da pessoa (revogados incluídos), com o último uso lido do memory (fora do ar: o último conhecido). */
  async list(userId: string): Promise<ComputerView[]> {
    const rows = (await this.repo.listForUser(userId)).filter((c) => c.confirmedAt);
    if (rows.length === 0) return [];
    let lastUsed = new Map<string, Date | null>();
    try {
      const { username } = await this.users.ensure(userId);
      lastUsed = new Map((await this.admin.listCredentials(username)).map((c) => [c.id, c.lastUsedAt]));
    } catch {
      // memory fora do ar: segue com o que está guardado
    }
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      os: c.os,
      agents: c.agents,
      installMode: c.installMode,
      createdAt: c.createdAt,
      lastSeenAt: lastUsed.get(c.credentialId) ?? c.lastSeenAt,
      revokedAt: c.revokedAt,
    }));
  }

  async active(userId: string): Promise<{ name: string; os: string; lastSeen: Date | null }[]> {
    return (await this.list(userId)).filter((c) => !c.revokedAt).map((c) => ({ name: c.name, os: c.os, lastSeen: c.lastSeenAt }));
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    const clean = cleanName(name);
    if (!clean) throw new ApiError(400, 'invalid_request', 'Informe um nome para o computador.');
    if (!(await this.repo.rename(id, userId, clean))) throw notFound();
  }

  /** Revoga a chave no memory (a pessoa perde o acesso daquele computador na hora) e marca como revogado. */
  async revoke(userId: string, id: string): Promise<void> {
    const c = await this.repo.find(id);
    if (!c || c.userId !== userId) throw notFound();
    if (c.revokedAt) return;
    await this.revokeRecord(c);
  }

  /** Todos os computadores da pessoa (usado no `DELETE /me`, antes do `disable`). */
  async revokeAll(userId: string): Promise<void> {
    for (const c of await this.repo.listForUser(userId)) if (!c.revokedAt) await this.revokeRecord(c);
  }

  /** Revoga o que foi emitido e nunca confirmado há mais de 10 min (chave perdida). Devolve quantos. */
  async sweep(userId?: string): Promise<number> {
    const stale = await this.repo.listUnconfirmed(new Date(this.now() - UNCONFIRMED_TTL_MS), userId);
    let n = 0;
    for (const c of stale) {
      try {
        await this.revokeRecord(c);
        n++;
      } catch {
        // memory fora do ar: a próxima varredura tenta de novo
      }
    }
    return n;
  }

  private async revokeRecord(c: MemoryComputerRecord): Promise<void> {
    try {
      await this.admin.revokeCredential(c.credentialId);
    } catch (e) {
      // credencial que já não existe no memory não impede marcar como revogado
      if (!(e instanceof MemoryAdminError && e.kind === 'not_found')) throw unavailable(e);
    }
    await this.repo.markRevoked(c.id, new Date(this.now()));
  }
}

const notFound = () => new ApiError(404, 'computer_not_found', 'Computador não encontrado.');
