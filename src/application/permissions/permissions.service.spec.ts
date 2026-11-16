import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryPermissions } from '../../../test/support/permission-fake';
import { PERMISSION_KEYS } from '../web/contract';
import { PERMISSION_CATALOG, PermissionsService } from './permissions.service';

const U = 'u1';
const APP_A = 'app-a';
const APP_B = 'app-b';

function make(opts: { connected?: boolean; access?: boolean } = {}) {
  const repo = new InMemoryPermissions();
  const state = { connected: opts.connected ?? true, access: opts.access ?? true };
  const service = new PermissionsService(
    repo,
    { hasSource: async () => state.connected, hasAccess: async () => state.access },
    () => new Date('2026-11-15T12:00:00Z'),
  );
  return { repo, service, state };
}

describe('PermissionsService (permissões por app)', () => {
  it('toda chave do contrato tem texto em pt-BR, fonte e risco no catálogo', () => {
    for (const k of PERMISSION_KEYS) {
      const d = PERMISSION_CATALOG[k];
      expect(d.title.length).toBeGreaterThan(5);
      expect(d.description.length).toBeGreaterThan(20);
      expect(k.startsWith(`${d.source}.`)).toBe(true);
      expect(['low', 'high']).toContain(d.risk);
    }
  });

  describe('oferta (offered)', () => {
    it('com a fonte conectada: tudo oferecido e disponível', async () => {
      const { service } = make();
      const items = await service.offered(U);
      expect(items.map((i) => i.key)).toEqual(['siasb.schedule_write', 'siasb.procedures_write']);
      expect(items.every((i) => i.available && i.unavailableReason === null)).toBe(true);
    });

    it('granted = já concedida a ESTE app (por cliente); sem app, tudo false', async () => {
      const { service } = make();
      await service.grant(U, 'app-a', ['siasb.procedures_write']);
      await service.grant(U, 'app-b', ['siasb.schedule_write']);
      expect((await service.offered(U, 'app-a')).map((i) => [i.key, i.granted])).toEqual([['siasb.schedule_write', false], ['siasb.procedures_write', true]]);
      expect((await service.offered(U, 'app-b')).map((i) => i.granted)).toEqual([true, false]);
      expect((await service.offered(U, 'app-novo')).map((i) => i.granted)).toEqual([false, false]);
      expect((await service.offered(U)).map((i) => i.granted)).toEqual([false, false]);
    });

    it('o legado /me/permissions não ganha o campo granted', async () => {
      const { service } = make();
      await service.grant(U, 'app-a', ['siasb.schedule_write']);
      expect((await service.list(U)).every((i) => !('granted' in i))).toBe(true);
    });

    it('textos neutros: dizem "o app", nunca "o Claude" (o app pode ser outro)', () => {
      for (const k of PERMISSION_KEYS) expect(`${PERMISSION_CATALOG[k].title} ${PERMISSION_CATALOG[k].description}`).not.toMatch(/Claude/);
      expect(PERMISSION_CATALOG['siasb.schedule_write'].title).toBe('Agendar e desmarcar sessões pelo app');
    });

    it('com acesso mas sem conexão: oferecido, porém indisponível (source_not_connected)', async () => {
      const { service } = make({ connected: false, access: true });
      const items = await service.offered(U);
      expect(items).toHaveLength(2);
      expect(items.every((i) => !i.available && i.unavailableReason === 'source_not_connected')).toBe(true);
    });

    it('sem acesso à fonte (nem conexão): nada é oferecido', async () => {
      const { service } = make({ connected: false, access: false });
      expect(await service.offered(U)).toEqual([]);
      expect(await service.list(U)).toEqual([]);
    });
  });

  describe('concessão por app', () => {
    it('grava o conjunto exato para UM app; o MCP lê só o do app que chama', async () => {
      const { service } = make();
      await service.grant(U, APP_A, await service.validate(U, ['siasb.schedule_write']));
      expect([...(await service.grantedKeys(U, APP_A))]).toEqual(['siasb.schedule_write']);
      expect((await service.grantedKeys(U, APP_B)).size).toBe(0);
    });

    it('chave de API (sem app): nenhuma permissão', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write']);
      expect((await service.grantedKeys(U, undefined)).size).toBe(0);
    });

    it('aprovar de novo troca o conjunto (vazio limpa)', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write', 'siasb.procedures_write']);
      await service.grant(U, APP_A, ['siasb.procedures_write']);
      expect([...(await service.grantedKeys(U, APP_A))]).toEqual(['siasb.procedures_write']);
      await service.grant(U, APP_A, []);
      expect((await service.grantedKeys(U, APP_A)).size).toBe(0);
    });

    it('as concessões são por pessoa e por app', async () => {
      const { service } = make();
      await service.grant('a', APP_A, ['siasb.schedule_write']);
      expect((await service.grantedKeys('b', APP_A)).size).toBe(0);
      expect((await service.grantedKeys('a', APP_B)).size).toBe(0);
    });

    it('validate: repetidas viram uma; chave desconhecida é 400; fonte desconectada é 409 permission_unavailable', async () => {
      const { service, state } = make();
      expect(await service.validate(U, ['siasb.schedule_write', 'siasb.schedule_write'])).toEqual(['siasb.schedule_write']);
      await expect(service.validate(U, ['siasb.nao_existe'])).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
      state.connected = false;
      await expect(service.validate(U, ['siasb.schedule_write'])).rejects.toMatchObject({ status: 409, code: 'permission_unavailable' });
      expect(await service.validate(U, [])).toEqual([]);
    });

    it('grantedTo agrupa por app com texto do catálogo', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write']);
      await service.grant(U, APP_B, ['siasb.procedures_write']);
      const m = await service.grantedTo(U);
      expect(m.get(APP_A)?.map((p) => p.key)).toEqual(['siasb.schedule_write']);
      expect(m.get(APP_B)?.[0]).toMatchObject({ key: 'siasb.procedures_write', risk: 'high', source: 'siasb' });
    });
  });

  describe('revogação', () => {
    it('retira UMA permissão de UM app, sem mexer nas outras; 404 se o app não a tinha', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write', 'siasb.procedures_write']);
      await service.grant(U, APP_B, ['siasb.schedule_write']);
      await service.revoke(U, APP_A, 'siasb.schedule_write');
      expect([...(await service.grantedKeys(U, APP_A))]).toEqual(['siasb.procedures_write']);
      expect([...(await service.grantedKeys(U, APP_B))]).toEqual(['siasb.schedule_write']);
      await expect(service.revoke(U, APP_A, 'siasb.schedule_write')).rejects.toMatchObject({ status: 404 });
      await expect(service.revoke(U, APP_A, 'siasb.nao_existe')).rejects.toMatchObject({ status: 400 });
    });

    it('revogar o app leva as permissões dele; as dos outros ficam', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write']);
      await service.grant(U, APP_B, ['siasb.schedule_write']);
      await service.appRevoked(U, APP_A);
      expect((await service.grantedKeys(U, APP_A)).size).toBe(0);
      expect((await service.grantedKeys(U, APP_B)).size).toBe(1);
    });

    it('desconectar a fonte apaga as permissões dela em TODOS os apps (e só as dela)', async () => {
      const { service, repo } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write', 'siasb.procedures_write']);
      await service.grant(U, APP_B, ['siasb.schedule_write']);
      await repo.replace(U, APP_B, ['siasb.schedule_write', 'outra.coisa'], new Date());
      await service.sourceDisconnected(U, 'siasb');
      expect((await repo.listByUser(U)).map((r) => r.key)).toEqual(['outra.coisa']);
    });
  });

  describe('legado de /me/permissions', () => {
    it('enabled = concedida a algum app', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write']);
      expect((await service.list(U)).map((i) => [i.key, i.enabled])).toEqual([
        ['siasb.schedule_write', true],
        ['siasb.procedures_write', false],
      ]);
    });

    it('desligar retira a chave de todos os apps; ligar é 400 (a permissão é dada ao autorizar o app)', async () => {
      const { service } = make();
      await service.grant(U, APP_A, ['siasb.schedule_write']);
      await service.grant(U, APP_B, ['siasb.schedule_write']);
      await service.set(U, 'siasb.schedule_write', false);
      expect((await service.grantedKeys(U, APP_A)).size + (await service.grantedKeys(U, APP_B)).size).toBe(0);
      await expect(service.set(U, 'siasb.schedule_write', true)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    });
  });

  it('a concessão entra na auditoria sem dado clínico (quem, app, chaves, quando)', async () => {
    const { Logger } = await import('@nestjs/common');
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service } = make();
    await service.grant(U, APP_A, ['siasb.procedures_write']);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('permissões do app:'));
    spy.mockRestore();
    expect(line).toBe('permissões do app: user=u1 app=app-a chaves=[siasb.procedures_write] em=2026-11-15T12:00:00.000Z');
  });

  it('a tabela apaga as linhas junto com a conta (cascade na migração)', () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261116200000_client_permissions', 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/"client_permissions_user_id_fkey".*REFERENCES "users"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/PRIMARY KEY \("user_id","client_id","key"\)/);
  });

  it('a migração que apaga user_permissions só derruba a tabela vazia (falha com mensagem clara se houver linha)', () => {
    const sql = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261116210000_drop_user_permissions', 'migration.sql'), 'utf-8');
    const guard = sql.indexOf('RAISE EXCEPTION');
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM "user_permissions")');
    expect(guard).toBeGreaterThan(-1);
    expect(sql.indexOf('DROP TABLE "user_permissions"')).toBeGreaterThan(guard);
  });
});
