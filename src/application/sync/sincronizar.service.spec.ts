import type {
  SourceAccountRecord,
  SourceAccountRepository,
  StoredHash,
  SyncBatch,
  SyncRepository,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import {
  SourceError,
  SourceFetchResult,
  SourceGateway,
  SourceRegistry,
} from '../ports/source-gateway';
import { itemHash } from './hashes';
import { itemKey } from './keys';
import {
  AccountNotConnectedError,
  MissingCredentialsError,
  SincronizarService,
} from './sincronizar.service';

const SENHA = 'senha-super-secreta-123';

class FakeCipher extends SecretCipher {
  encrypt(p: string) {
    return { ciphertext: p, iv: 'i', authTag: 't' };
  }
  decrypt(s: { ciphertext: string }) {
    return s.ciphertext;
  }
}

function setup(gateway: SourceGateway, preAccounts: SourceAccountRecord[] = []) {
  const log: unknown[] = []; // tudo que "vai ao banco" fica aqui
  const accounts = [...preAccounts];
  let stored: Record<string, StoredHash[]> = {};
  const applied: Array<Record<string, SyncBatch<unknown> | string>> = [];

  const accountRepo = {
    upsert: async (i: { userId: string; provider: string; accountKey: string }) => {
      log.push(['upsert', i]);
      const rec = {
        id: 'acc1',
        siteUrl: null,
        status: 'OK',
        lastSyncedAt: null,
        secret: null,
        ...i,
      } as SourceAccountRecord;
      accounts.push(rec);
      return rec;
    },
    findByUserAndProvider: async (userId: string, provider: string) =>
      accounts.filter((a) => a.userId === userId && a.provider === provider),
    setStatus: async (...a: unknown[]) => void log.push(['setStatus', a]),
    markSynced: async () => undefined,
    saveProfile: async (...a: unknown[]) => void log.push(['saveProfile', a]),
  } as unknown as SourceAccountRepository;

  const runs: unknown[] = [];
  const syncRepo = {
    startRun: async (i: unknown) => {
      log.push(['startRun', i]);
      return { id: 'run1', startedAt: new Date() };
    },
    finishRun: async (id: string, r: unknown) => {
      log.push(['finishRun', r]);
      runs.push(r);
    },
    storedHashes: async (_a: string, e: string) => stored[e] ?? [],
    apply: async (i: Record<string, SyncBatch<unknown> | string>) => {
      log.push(['apply', i]);
      applied.push(i);
    },
  } as unknown as SyncRepository;

  const registry = new SourceRegistry();
  registry.register(gateway);
  const service = new SincronizarService(registry, accountRepo, syncRepo, new FakeCipher());
  return {
    service,
    log,
    runs,
    applied,
    setStored: (s: Record<string, StoredHash[]>) => (stored = s),
  };
}

const item = (externalId: string, title: string) => ({
  courseExternalId: 'c1',
  kind: 'ASSIGNMENT' as const,
  externalId,
  title,
});

function gw(
  provider: 'SIGAA' | 'MOODLE',
  fetch: () => Promise<SourceFetchResult>,
): SourceGateway {
  return {
    provider,
    auth: provider === 'SIGAA' ? 'segredo-por-requisicao' : 'token-guardado',
    fetch,
  };
}

describe('SincronizarService', () => {
  it('classifica novo/alterado/removido e conta', async () => {
    const a = item('a', 'A');
    const b = item('b', 'B novo titulo');
    const { service, setStored, applied } = setup(
      gw('MOODLE', async () => ({
        courseSpaces: [{ externalId: 'c1', name: 'Cálculo' }],
        items: [a, b, item('n', 'N')],
      })),
      [
        {
          id: 'acc1',
          userId: 'u1',
          provider: 'MOODLE',
          accountKey: 'm',
          siteUrl: null,
          status: 'OK',
          lastSyncedAt: null,
          secret: { ciphertext: 'tok', iv: 'i', authTag: 't' },
        },
      ],
    );
    setStored({
      ITEM: [
        { externalId: itemKey(a), contentHash: itemHash(a) }, // igual
        { externalId: itemKey(item('b', 'B')), contentHash: itemHash(item('b', 'B')) }, // alterado
        { externalId: itemKey(item('gone', 'X')), contentHash: 'h' }, // removido
      ],
    });
    const r = await service.sincronizar({
      userId: 'u1',
      provider: 'MOODLE',
      alcance: { kind: 'tudo' },
    });
    expect(r.counts).toEqual({ created: 2, updated: 1, removed: 1, unchanged: 1 });
    expect(r.atualizadoEm).toBeInstanceOf(Date);
    const items = applied[0].items as SyncBatch<unknown>;
    expect(items.removed).toEqual([itemKey(item('gone', 'X'))]);
  });

  it('alcance curso/item não remove o que não foi pedido', async () => {
    const { service, setStored, applied } = setup(
      gw('MOODLE', async () => ({ items: [item('a', 'A')] })),
      [
        {
          id: 'acc1',
          userId: 'u1',
          provider: 'MOODLE',
          accountKey: 'm',
          siteUrl: null,
          status: 'OK',
          lastSyncedAt: null,
          secret: { ciphertext: 'tok', iv: 'i', authTag: 't' },
        },
      ],
    );
    setStored({ ITEM: [{ externalId: itemKey(item('z', 'Z')), contentHash: 'h' }] });
    await service.sincronizar({
      userId: 'u1',
      provider: 'MOODLE',
      alcance: { kind: 'item', courseExternalId: 'c1', itemExternalId: 'a' },
    });
    expect((applied[0].items as SyncBatch<unknown>).removed).toEqual([]);
  });

  it('SIGAA: a conta é gravada sem segredo e a senha nunca chega ao banco nem ao log de erro', async () => {
    let seenPassword: string | undefined;
    const { service, log, runs } = setup(
      gw('SIGAA', async () => {
        throw new SourceError('CREDENTIAL_REJECTED', `login falhou para senha ${SENHA}`);
      }),
    );
    // gateway espiona o contexto
    (service as unknown as { registry: SourceRegistry }).registry.register({
      provider: 'SIGAA',
      auth: 'segredo-por-requisicao',
      fetch: async (ctx) => {
        if (ctx.credentials.kind === 'password') seenPassword = ctx.credentials.password;
        throw new SourceError('CREDENTIAL_REJECTED', `login falhou para senha ${SENHA}`);
      },
    });
    await expect(
      service.sincronizar({
        userId: 'u1',
        provider: 'SIGAA',
        alcance: { kind: 'tudo' },
        senha: { username: 'aluno', password: SENHA },
      }),
    ).rejects.toBeInstanceOf(SourceError);

    expect(seenPassword).toBe(SENHA); // o gateway recebe a senha, em memória
    const upsert = log.find((l) => (l as unknown[])[0] === 'upsert') as unknown[];
    expect(JSON.stringify(upsert)).not.toContain('secret');
    expect(JSON.stringify(log)).not.toContain(SENHA); // nada persistido contém a senha
    expect(runs[0]).toMatchObject({ ok: false, errorCode: 'CREDENTIAL_REJECTED' });
    expect(log.some((l) => (l as unknown[])[0] === 'setStatus')).toBe(true);
  });

  it('SIGAA sem senha é recusado; fonte com token sem conta também', async () => {
    const s1 = setup(gw('SIGAA', async () => ({})));
    await expect(
      s1.service.sincronizar({ userId: 'u1', provider: 'SIGAA', alcance: { kind: 'tudo' } }),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
    const s2 = setup(gw('MOODLE', async () => ({})));
    await expect(
      s2.service.sincronizar({ userId: 'u1', provider: 'MOODLE', alcance: { kind: 'tudo' } }),
    ).rejects.toBeInstanceOf(AccountNotConnectedError);
  });
});
