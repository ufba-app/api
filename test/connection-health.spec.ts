import type { SourceHealthRow } from '../src/application/ports/source-health';
import { ConnectionStatus } from '../src/application/web/connection-status';

const TOKEN = 'CANARIO-token-saude-5521';
const principal = { userId: 'u1', clientId: 'c' } as never;
const now = Date.parse('2026-11-16T12:00:00Z');
const at = new Date(now - 60_000);

function build(rows: SourceHealthRow[], opts: { moodle?: 'OK' | 'REAUTH_NEEDED'; throwList?: boolean } = {}) {
  const acc = (provider: string, accountKey: string, status: string) => ({
    id: accountKey,
    userId: 'u1',
    provider,
    accountKey,
    status,
    secret: { ciphertext: TOKEN, iv: '', authTag: '' },
    expiresAt: null,
    lastSyncedAt: null,
    siteUrl: null,
  });
  const accounts = {
    findByUserAndProvider: async (_u: string, p: string) =>
      p === 'MOODLE'
        ? [acc('MOODLE', 'ava:a', opts.moodle ?? 'OK')]
        : p === 'CLASSROOM'
          ? [acc('CLASSROOM', 'a@ufba.br', 'OK'), acc('CLASSROOM', 'b@gmail.com', 'REAUTH_NEEDED')]
          : [],
  };
  const cofre = { cofre: async () => ({ login: '123', status: 'OK' }), abrir: async () => ({}) };
  const link = {
    status: async () => ({ state: 'disconnected', expiresAt: null, syncedAt: null, syncResult: null }),
    offer: async () => ({ offered: false }),
    hasRegistration: async () => false,
  };
  const repo = {
    list: async () => {
      if (opts.throwList) throw new Error('db');
      return rows;
    },
  };
  const classroom = { enabled: () => true, apps: () => ['ufba', 'convidado'] };
  return new ConnectionStatus(cofre as never, accounts as never, classroom as never, { count: async () => 0 } as never, link as never, () => now, 30, repo as never);
}

const row = (o: Partial<SourceHealthRow>): SourceHealthRow => ({
  provider: 'MOODLE',
  accountKey: 'ava:a',
  state: 'ok',
  reason: null,
  lastSuccessAt: at,
  lastFailureAt: null,
  ...o,
});

describe('Me.connections.*.health', () => {
  it('Moodle ok com leitura gravada; Classroom: uma saúde por conta', async () => {
    const c = await build([row({}), row({ provider: 'CLASSROOM', accountKey: 'a@ufba.br' })]).connections(principal);
    expect(c.moodle.health).toMatchObject({ state: 'ok', since: at.toISOString() });
    expect(c.classroom.accounts[0].health).toMatchObject({ state: 'ok' });
    expect(c.classroom.accounts[1].health).toMatchObject({ state: 'action_required', reason: 'token_revoked', action: 'reconnect' });
    expect(c.siasb.health).toBeNull();
  });

  it('Moodle fora do ar vira degraded; sem registro, unknown', async () => {
    const falha = row({ state: 'failing', reason: 'source_unavailable', lastFailureAt: at });
    expect((await build([falha]).connections(principal)).moodle.health).toMatchObject({ state: 'degraded', reason: 'source_unavailable' });
    expect((await build([]).connections(principal)).moodle.health).toMatchObject({ state: 'unknown', reason: 'never_read' });
  });

  it('REAUTH ganha de qualquer registro de leitura', async () => {
    const c = await build([row({})], { moodle: 'REAUTH_NEEDED' }).connections(principal);
    expect(c.moodle.status).toBe('reconnect_required');
    expect(c.moodle.health).toMatchObject({ state: 'action_required', reason: 'token_revoked' });
  });

  it('falha ao ler a saúde nunca derruba o /me', async () => {
    const c = await build([], { throwList: true }).connections(principal);
    expect(c.moodle.health).toMatchObject({ state: 'unknown' });
  });

  it('canário: nada de token na saída da saúde', async () => {
    const c = await build([row({})]).connections(principal);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });
});
