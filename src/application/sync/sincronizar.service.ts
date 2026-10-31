import { Injectable } from '@nestjs/common';
import { detectChanges } from '../../domain/sync/detect-changes';
import {
  SourceAccountRecord,
  SourceAccountRepository,
  StoredHash,
  SyncBatch,
  SyncCounts,
  SyncRepository,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import {
  Provider,
  SourceContext,
  SourceError,
  SourceRegistry,
  SyncScope,
} from '../ports/source-gateway';
import {
  courseSpaceHash,
  eventHash,
  gradeHash,
  itemHash,
} from './hashes';
import { eventKey, gradeKey, itemKey } from './keys';

export class SourceNotRegisteredError extends Error {}
export class AccountNotConnectedError extends Error {}
export class MissingCredentialsError extends Error {}

export interface SincronizarInput {
  userId: string;
  provider: Provider;
  alcance: SyncScope;
  /** Só para fontes `segredo-por-requisicao` (SIGAA). Usada em memória e descartada: nunca gravada nem logada. */
  senha?: { username: string; password: string };
  /** Escolhe a conta quando há mais de uma da mesma fonte. */
  accountKey?: string;
}

export interface SincronizarResult {
  syncRunId: string;
  provider: Provider;
  counts: SyncCounts;
  atualizadoEm: Date;
}

const SIGAA_ACCOUNT_KEY = 'sigaa';

/**
 * Único comando que vai às fontes (docs/ARQUITETURA.md §2.2). Busca pelo gateway, compara por hash com o banco
 * (`detectChanges`), grava o que mudou e registra `ChangeEvent`s e o `SyncRun`.
 */
@Injectable()
export class SincronizarService {
  constructor(
    private readonly registry: SourceRegistry,
    private readonly accounts: SourceAccountRepository,
    private readonly sync: SyncRepository,
    private readonly cipher: SecretCipher,
  ) {}

  async sincronizar(input: SincronizarInput): Promise<SincronizarResult> {
    const gateway = this.registry.get(input.provider);
    if (!gateway) throw new SourceNotRegisteredError(input.provider);

    const { account, ctx } = await this.resolveAccount(input, gateway.auth);
    const scope = input.alcance;
    const course = scope.kind === 'tudo' ? undefined : scope.courseExternalId;
    const run = await this.sync.startRun({
      sourceAccountId: account.id,
      scope: scope.kind === 'tudo' ? 'ALL' : scope.kind === 'curso' ? 'COURSE' : 'ITEM',
      scopeRef:
        scope.kind === 'curso'
          ? scope.courseExternalId
          : scope.kind === 'item'
            ? `${scope.courseExternalId}/${scope.itemExternalId}`
            : undefined,
    });

    try {
      const result = await gateway.fetch(ctx, scope);

      const full = scope.kind === 'tudo';
      const removeInCourse = scope.kind !== 'item';
      const stored = (entity: Parameters<SyncRepository['storedHashes']>[1]) =>
        this.sync.storedHashes(account.id, entity, course);

      const courseSpaces = result.courseSpaces
        ? classify(
            await stored('COURSE_SPACE'),
            result.courseSpaces,
            (c) => c.externalId,
            courseSpaceHash,
            full,
          )
        : undefined;
      const items = result.items
        ? classify(await stored('ITEM'), result.items, itemKey, itemHash, removeInCourse)
        : undefined;
      const grades = result.grades
        ? classify(await stored('GRADE_ENTRY'), result.grades, gradeKey, gradeHash, removeInCourse)
        : undefined;
      const events = result.events
        ? classify(await stored('CALENDAR_EVENT'), result.events, eventKey, eventHash, full)
        : undefined;

      await this.sync.apply({
        sourceAccountId: account.id,
        runId: run.id,
        courseSpaces,
        items,
        grades,
        events,
      });

      const counts = sumCounts([courseSpaces, items, grades, events]);
      if (result.profile) {
        await this.accounts.saveProfile(input.userId, result.profile);
      }
      await this.sync.finishRun(run.id, { ok: true, counts });
      const atualizadoEm = new Date();
      await this.accounts.markSynced(account.id, atualizadoEm);
      return { syncRunId: run.id, provider: input.provider, counts, atualizadoEm };
    } catch (err) {
      const code = err instanceof SourceError ? err.code : 'INTERNAL';
      await this.sync.finishRun(run.id, {
        ok: false,
        errorCode: code,
        errorMessage: scrub(err, input.senha?.password),
      });
      if (code === 'REAUTH_NEEDED' || code === 'CREDENTIAL_REJECTED') {
        await this.accounts.setStatus(account.id, 'REAUTH_NEEDED', code);
      } else if (code === 'BLOCKED') {
        await this.accounts.setStatus(account.id, 'BLOCKED', code);
      }
      throw err;
    }
  }

  private async resolveAccount(
    input: SincronizarInput,
    auth: 'token-guardado' | 'segredo-por-requisicao',
  ): Promise<{ account: SourceAccountRecord; ctx: SourceContext }> {
    if (auth === 'segredo-por-requisicao') {
      if (!input.senha) throw new MissingCredentialsError('usuário e senha são obrigatórios');
      // A conta é gravada SEM segredo: a senha só existe em `ctx`, em memória.
      const account = await this.accounts.upsert({
        userId: input.userId,
        provider: input.provider,
        accountKey: input.accountKey ?? SIGAA_ACCOUNT_KEY,
      });
      return {
        account,
        ctx: {
          userId: input.userId,
          accountKey: account.accountKey,
          siteUrl: account.siteUrl ?? undefined,
          credentials: {
            kind: 'password',
            username: input.senha.username,
            password: input.senha.password,
          },
        },
      };
    }

    const candidates = await this.accounts.findByUserAndProvider(input.userId, input.provider);
    const account = input.accountKey
      ? candidates.find((a) => a.accountKey === input.accountKey)
      : candidates[0];
    if (!account) throw new AccountNotConnectedError(input.provider);
    if (!account.secret) throw new MissingCredentialsError('conta sem token guardado');
    return {
      account,
      ctx: {
        userId: input.userId,
        accountKey: account.accountKey,
        siteUrl: account.siteUrl ?? undefined,
        credentials: { kind: 'token', token: this.cipher.decrypt(account.secret) },
      },
    };
  }
}

function classify<T>(
  stored: StoredHash[],
  incoming: T[],
  keyOf: (t: T) => string,
  hashOf: (t: T) => string,
  allowRemove: boolean,
): SyncBatch<T> {
  const byKey = new Map(incoming.map((t) => [keyOf(t), t]));
  const hashes = new Map(incoming.map((t) => [keyOf(t), hashOf(t)]));
  const changes = detectChanges(
    stored,
    [...byKey.keys()].map((externalId) => ({
      externalId,
      contentHash: hashes.get(externalId) as string,
    })),
  );
  const pick = (k: { externalId: string }) => ({
    data: byKey.get(k.externalId) as T,
    hash: hashes.get(k.externalId) as string,
  });
  return {
    created: changes.created.map(pick),
    updated: changes.updated.map(pick),
    unchanged: changes.unchanged.map((k) => ({ data: byKey.get(k.externalId) as T })),
    removed: allowRemove ? changes.removed.map((k) => k.externalId) : [],
  };
}

function sumCounts(batches: Array<SyncBatch<unknown> | undefined>): SyncCounts {
  const counts: SyncCounts = { created: 0, updated: 0, removed: 0, unchanged: 0 };
  for (const b of batches) {
    if (!b) continue;
    counts.created += b.created.length;
    counts.updated += b.updated.length;
    counts.removed += b.removed.length;
    counts.unchanged += b.unchanged.length;
  }
  return counts;
}

/** Mensagem de erro segura para gravar: sem a senha, mesmo que a fonte a repita. */
function scrub(err: unknown, secret?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (secret) msg = msg.split(secret).join('***');
  return msg.slice(0, 500);
}
