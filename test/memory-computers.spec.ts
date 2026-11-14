import { DeviceAuthorizations, normalizeUserCode, ipHint } from '../src/application/memory/device-authorizations';
import { InstallManifests, ManifestUnavailable } from '../src/application/memory/install-manifest';
import { MemoryComputers, MAX_ACTIVE_COMPUTERS, UNCONFIRMED_TTL_MS } from '../src/application/memory/memory-computers';
import { MemoryUsers } from '../src/application/memory/memory-users';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { HttpManifestSource } from '../src/infrastructure/memory/http-manifest-source';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';
import { InMemoryComputerRepo, InMemoryDeviceRepo, InMemoryUserRepo } from './support/memory-fakes';

const ROOT = 'root-token-computers-0005';
const UID = 'user-aaaaaaaaaaaa';
const OTHER = 'user-bbbbbbbbbbbb';

describe('computadores conectados (serviço, com relógio controlado)', () => {
  let fake: FakeAiMemory;
  let clock: number;
  let repo: InMemoryComputerRepo;
  let svc: MemoryComputers;

  beforeEach(async () => {
    clock = 1_000_000_000_000;
    fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    const admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    const users = new MemoryUsers(admin, new InMemoryUserRepo(), new AesSecretCipher(Buffer.alloc(32, 3).toString('base64')));
    repo = new InMemoryComputerRepo();
    svc = new MemoryComputers(admin, users, repo, () => clock);
  });
  afterEach(() => fake.stop());

  const mk = (name = 'pc') => svc.create(UID, { name, os: 'linux' });
  /** Criado e confirmado (senão a varredura revoga depois de 10 min). */
  const mkc = async (name: string) => {
    const c = await mk(name);
    await svc.confirm(UID, c.computerId);
    return c;
  };

  it('rótulo da credencial leva o id curto e o nome; a chave não é guardada', async () => {
    const c = await mk('Notebook');
    const cred = fake.credentials.find((x) => x.token === c.key.reveal())!;
    expect(cred.label).toBe(`pc:${c.computerId.slice(0, 8)}:Notebook`);
    expect(JSON.stringify([...repo.rows.values()])).not.toContain(c.key.reveal());
    expect(c.key.toString()).toBe('[redacted]');
  });

  it('nome sugerido pelo instalador é saneado e o sistema precisa ser conhecido', async () => {
    const c = await svc.create(UID, { name: '  <b>Meu\u0007 PC</b>\n', os: 'macos' });
    expect(repo.rows.get(c.computerId)!.name).toBe('b Meu PC /b');
    await expect(svc.create(UID, { name: 'x', os: 'amiga' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('teto de 10 computadores ativos (revogar libera) e 5 conexões por hora', async () => {
    for (let i = 0; i < 5; i++) await mkc(`pc${i}`);
    await expect(mk('seis')).rejects.toMatchObject({ code: 'too_many_attempts' });
    clock += 60 * 60_000 + 1;
    for (let i = 5; i < MAX_ACTIVE_COMPUTERS; i++) await mkc(`pc${i}`);
    clock += 60 * 60_000 + 1;
    await expect(mk('onze')).rejects.toMatchObject({ code: 'computer_limit_reached', status: 409 });
    const first = [...repo.rows.values()][0];
    await svc.revoke(UID, first.id);
    await expect(mk('onze')).resolves.toBeDefined();
    expect(fake.credentials.filter((c) => c.label.startsWith('pc:') && !c.revoked_at)).toHaveLength(MAX_ACTIVE_COMPUTERS);
  });

  it('não confirmado em 10 min: a varredura revoga a chave e o computador some da lista', async () => {
    const lost = await mk('perdido');
    const ok = await mk('bom');
    await svc.confirm(UID, ok.computerId);
    clock += UNCONFIRMED_TTL_MS - 1000;
    expect(await svc.sweep()).toBe(0);
    clock += 2000;
    expect(await svc.sweep()).toBe(1);
    expect(fake.authenticate(lost.key.reveal())).toBeNull();
    expect(fake.authenticate(ok.key.reveal())).not.toBeNull();
    expect((await svc.list(UID)).map((c) => c.name)).toEqual(['bom']);
    expect(await svc.sweep()).toBe(0);
  });

  it('varredura com o memory fora do ar não perde o registro: tenta de novo depois', async () => {
    const lost = await mk('perdido');
    clock += UNCONFIRMED_TTL_MS + 1;
    await fake.stop();
    expect(await svc.sweep()).toBe(0);
    expect(repo.rows.get(lost.computerId)!.revokedAt).toBeNull();
  });

  it('revoke é do dono, idempotente, e revoke de tudo corta todas as chaves', async () => {
    const a = await mk('a');
    const b = await mk('b');
    await svc.confirm(UID, a.computerId);
    await svc.confirm(UID, b.computerId);
    await expect(svc.revoke(OTHER, a.computerId)).rejects.toMatchObject({ code: 'computer_not_found' });
    await svc.revoke(UID, a.computerId);
    await svc.revoke(UID, a.computerId);
    expect(fake.authenticate(a.key.reveal())).toBeNull();
    await svc.revokeAll(UID);
    expect(fake.authenticate(b.key.reveal())).toBeNull();
    expect((await svc.active(UID))).toEqual([]);
  });

  it('reinstalação (mesmo computer_id) zera a confirmação e o tempo corre de novo', async () => {
    const a = await mk('a');
    await svc.confirm(UID, a.computerId);
    clock += 30 * 60_000;
    const again = await svc.create(UID, { name: 'a', os: 'linux', computerId: a.computerId });
    expect(again.computerId).toBe(a.computerId);
    expect(repo.rows.get(a.computerId)!.confirmedAt).toBeNull();
    clock += UNCONFIRMED_TTL_MS + 1;
    expect(await svc.sweep()).toBe(1);
  });
});

describe('login de dispositivo (serviço)', () => {
  let repo: InMemoryDeviceRepo;
  let clock: number;
  let dev: DeviceAuthorizations;

  beforeEach(() => {
    clock = 1_000_000_000_000;
    repo = new InMemoryDeviceRepo();
    dev = new DeviceAuthorizations(repo, { now: () => clock, webOrigin: () => 'https://ufba.app' });
  });

  const begin = (ip = '200.128.1.2') =>
    dev.start({ clientId: 'ufba-installer', scope: 'memory:connect', computerName: 'PC', os: 'linux', ip });

  it('o código expira em 10 min e o token curto também (10 min depois de emitido)', async () => {
    const d = await begin();
    clock += 10 * 60_000 + 1;
    await expect(dev.poll({ deviceCode: d.device_code, clientId: 'ufba-installer' })).rejects.toMatchObject({ error: 'expired_token' });
    await expect(dev.lookup(UID, null, d.user_code)).rejects.toMatchObject({ code: 'device_code_expired' });

    const e = await begin();
    await dev.decide(UID, null, e.user_code, 'approve');
    clock += 6000;
    const t = await dev.poll({ deviceCode: e.device_code, clientId: 'ufba-installer' });
    expect(await dev.verifyToken(t.access_token)).toMatchObject({ userId: UID });
    clock += 10 * 60_000 + 1;
    expect(await dev.verifyToken(t.access_token)).toBeNull();
  });

  it('aprovar duas vezes ou depois de negar não funciona', async () => {
    const d = await begin();
    await dev.decide(UID, null, d.user_code, 'deny');
    await expect(dev.decide(UID, null, d.user_code, 'approve')).rejects.toMatchObject({ code: 'device_code_invalid' });
  });

  it('device_code de outro cliente não resgata', async () => {
    const d = await begin();
    await expect(dev.poll({ deviceCode: d.device_code, clientId: 'ufba-web' })).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('120 consultas por device_code; slow_down aumenta o intervalo', async () => {
    const d = await begin();
    await expect(dev.poll({ deviceCode: d.device_code, clientId: 'ufba-installer' })).rejects.toMatchObject({ error: 'authorization_pending' });
    await expect(dev.poll({ deviceCode: d.device_code, clientId: 'ufba-installer' })).rejects.toMatchObject({ error: 'slow_down' });
    expect([...repo.rows.values()][0].intervalSec).toBe(10);
    for (const r of repo.rows.values()) r.pollCount = 120;
    clock += 60_000;
    await expect(dev.poll({ deviceCode: d.device_code, clientId: 'ufba-installer' })).rejects.toMatchObject({ error: 'expired_token' });
  });

  it('10 pedidos por hora por IP', async () => {
    for (let i = 0; i < 10; i++) await begin('10.1.1.1');
    await expect(begin('10.1.1.1')).rejects.toMatchObject({ error: 'slow_down', status: 429 });
    await expect(begin('10.2.2.2')).resolves.toBeDefined();
    clock += 60 * 60_000 + 1;
    await expect(begin('10.1.1.1')).resolves.toBeDefined();
  });

  it('20 pedidos em aberto por IP', async () => {
    const small = new DeviceAuthorizations(repo, { now: () => clock, webOrigin: () => 'https://ufba.app' });
    for (let i = 0; i < 20; i++) {
      await small.start({ clientId: 'ufba-installer', scope: 'memory:connect', ip: `9.9.9.9` }).catch(() => undefined);
      clock += 7 * 60_000; // contorna o limite por hora (10/h) sem deixar os pedidos expirarem
      for (const r of repo.rows.values()) r.expiresAt = new Date(clock + 60_000);
    }
    expect(repo.rows.size).toBe(20);
    await expect(small.start({ clientId: 'ufba-installer', scope: 'memory:connect', ip: '9.9.9.9' })).rejects.toMatchObject({ status: 429 });
  });

  it('ip diferente de quem pediu destaca o aviso (e só mostra a rede, não o endereço)', async () => {
    const d = await begin('200.128.7.9');
    const same = await dev.lookup(UID, '200.128.9.9', d.user_code);
    expect(same.ipDiffers).toBe(false);
    expect(same.approxLocation).toBe('rede 200.128.x.x');
    const far = await dev.lookup(UID, '45.10.1.1', d.user_code);
    expect(far.ipDiffers).toBe(true);
    expect(JSON.stringify(far)).not.toContain('200.128.7.9');
  });

  it('normaliza o código e rejeita o que não pode ser código', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK');
    expect(normalizeUserCode(' BCDF GHJK ')).toBe('BCDFGHJK');
    for (const bad of ['BCDF-GHJA', 'BCDF', '', 7, null, 'BCDF-GHJK-L']) expect(normalizeUserCode(bad)).toBeNull();
    expect(ipHint('::ffff:200.128.1.2')).toBe('200.128.x.x');
    expect(ipHint('2001:db8:1:2::3')).toBe('2001:db8::');
    expect(ipHint(null)).toBeNull();
  });
});

describe('manifesto de instalação', () => {
  const SHA = 'b'.repeat(64);
  const good = {
    schema: 1,
    aiMemory: { version: '3.4.6', artifacts: { 'linux-x64': { url: 'https://github.com/a/b.tgz', sha256: SHA } } },
    installer: { version: '1.0.0', minVersion: '1.0.0', files: { 'install.sh': SHA } },
  };

  it('valida, guarda em cache por 10 min e serve o último bom se a origem cair', async () => {
    let clock = 0;
    let next: unknown = good;
    let calls = 0;
    const m = new InstallManifests({ fetch: async () => (calls++, next) }, () => clock);
    expect((await m.get()).aiMemory.version).toBe('3.4.6');
    await m.get();
    expect(calls).toBe(1);
    next = { schema: 1 }; // inválido
    clock += 10 * 60_000 + 1;
    expect((await m.get()).aiMemory.version).toBe('3.4.6'); // último bom
    expect(calls).toBe(2);
  });

  it('sem nenhum bom guardado, inválido ou fora do ar vira indisponível; hash e https são obrigatórios', async () => {
    for (const bad of [
      { ...good, aiMemory: { ...good.aiMemory, artifacts: { x: { url: 'http://x/y', sha256: SHA } } } },
      { ...good, aiMemory: { ...good.aiMemory, artifacts: { x: { url: 'https://x/y', sha256: 'abc' } } } },
      null,
    ]) {
      await expect(new InstallManifests({ fetch: async () => bad }).get()).rejects.toBeInstanceOf(ManifestUnavailable);
    }
    await expect(
      new InstallManifests({ fetch: async () => Promise.reject(new Error('rede')) }).get(),
    ).rejects.toBeInstanceOf(ManifestUnavailable);
  });

  it('origem só em https no GitHub, mesmo depois de redirecionar', async () => {
    expect(() => new HttpManifestSource('http://github.com/x')).toThrow();
    expect(() => new HttpManifestSource('https://evil.example/m.json')).toThrow();
    const redirected = new HttpManifestSource('https://github.com/ufba-app/memory/releases/latest/download/manifest.json', (async () =>
      ({ ok: true, url: 'https://evil.example/m.json', text: async () => '{}' }) as unknown as Response) as typeof fetch);
    await expect(redirected.fetch()).rejects.toThrow();
    const fine = new HttpManifestSource('https://github.com/ufba-app/memory/releases/latest/download/manifest.json', (async () =>
      ({ ok: true, url: 'https://release-assets.githubusercontent.com/x', text: async () => JSON.stringify(good) }) as unknown as Response) as typeof fetch);
    expect(await fine.fetch()).toEqual(good);
  });
});
