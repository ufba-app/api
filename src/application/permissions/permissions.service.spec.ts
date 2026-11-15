import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryPermissions } from '../../../test/support/permission-fake';
import { PERMISSION_KEYS } from '../web/contract';
import { PERMISSION_CATALOG, PermissionsService } from './permissions.service';

const U = 'u1';

function make(connected = true) {
  const repo = new InMemoryPermissions();
  let hasSource = connected;
  const service = new PermissionsService(repo, { hasSource: async () => hasSource }, () => new Date('2026-11-15T12:00:00Z'));
  return { repo, service, setConnected: (v: boolean) => (hasSource = v) };
}

describe('PermissionsService', () => {
  it('toda chave do contrato tem texto em pt-BR, fonte e risco no catálogo', () => {
    for (const k of PERMISSION_KEYS) {
      const d = PERMISSION_CATALOG[k];
      expect(d.title.length).toBeGreaterThan(5);
      expect(d.description.length).toBeGreaterThan(20);
      expect(k.startsWith(`${d.source}.`)).toBe(true);
      expect(['low', 'high']).toContain(d.risk);
    }
  });

  it('sem linha no banco: tudo desligado; com a fonte conectada: disponível', async () => {
    const { service } = make(true);
    const items = await service.list(U);
    expect(items.every((i) => i.enabled === false && i.available && i.unavailableReason === null)).toBe(true);
  });

  it('liga e desliga; só a chave tocada muda; as ligadas saem em enabledKeys', async () => {
    const { service } = make(true);
    await service.set(U, 'siasb.schedule_write', true);
    expect((await service.list(U)).map((i) => [i.key, i.enabled])).toEqual([
      ['siasb.schedule_write', true],
      ['siasb.procedures_write', false],
    ]);
    expect([...(await service.enabledKeys(U))]).toEqual(['siasb.schedule_write']);
    await service.set(U, 'siasb.schedule_write', false);
    expect((await service.enabledKeys(U)).size).toBe(0);
  });

  it('as permissões são por pessoa', async () => {
    const { service } = make(true);
    await service.set('a', 'siasb.schedule_write', true);
    expect((await service.enabledKeys('b')).size).toBe(0);
  });

  it('ligar sem conexão: 409 permission_unavailable; desligar sempre pode', async () => {
    const { service, repo } = make(false);
    await expect(service.set(U, 'siasb.schedule_write', true)).rejects.toMatchObject({ status: 409, code: 'permission_unavailable' });
    expect(repo.rows.size).toBe(0);
    await expect(service.set(U, 'siasb.schedule_write', false)).resolves.toBeUndefined();
    expect((await service.list(U)).every((i) => !i.available && i.unavailableReason === 'source_not_connected')).toBe(true);
  });

  it('desconectar a fonte apaga as permissões dela (e só as dela)', async () => {
    const { service, repo } = make(true);
    await service.set(U, 'siasb.schedule_write', true);
    await service.set(U, 'siasb.procedures_write', true);
    await repo.set(U, 'outra.coisa', true, new Date());
    await service.sourceDisconnected(U, 'siasb');
    expect((await repo.list(U)).map((r) => r.key)).toEqual(['outra.coisa']);
  });

  it('a mudança entra na auditoria sem dado clínico (quem, chave, valor, quando)', async () => {
    const { Logger } = await import('@nestjs/common');
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = make(true);
    await service.set(U, 'siasb.procedures_write', true);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('permissão:'));
    spy.mockRestore();
    expect(line).toBe('permissão: user=u1 chave=siasb.procedures_write valor=true em=2026-11-15T12:00:00.000Z');
  });

  it('a tabela apaga as linhas junto com a conta (cascade na migração)', () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261115190000_user_permissions', 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/"user_permissions_user_id_fkey".*REFERENCES "users"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/PRIMARY KEY \("user_id","key"\)/);
  });
});
