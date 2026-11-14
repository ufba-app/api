import { Logger } from '@nestjs/common';
import { inspect } from 'node:util';
import { MemoryAdminError, MemoryUserRecord, MemoryUserRepository } from '../src/application/memory/memory-ports';
import { MemoryUsers } from '../src/application/memory/memory-users';
import type { EncryptedSecret } from '../src/application/ports/repositories';
import { Secret } from '../src/application/shared/secret';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { MemoryAdminClient } from '../src/infrastructure/memory/memory-admin.client';
import { FAKE_TEMP_PASSWORD, FakeAiMemory } from '../src/infrastructure/memory/testing/fake-ai-memory';

/**
 * Canário da memória: o token root, a chave de repasse, a chave de computador e a senha temporária do usuário no
 * ai-memory não podem aparecer em stdout, stderr, console, Logger, erros ou JSON de nada que a ufba.app produz.
 * (Quando o proxy, o device flow e as rotas chegarem, entram aqui os valores novos: etapas 2 e 3.)
 */
const ROOT = 'CANARIO-root-memory-0002';

class Repo extends MemoryUserRepository {
  row: MemoryUserRecord | null = null;
  async find() {
    return this.row;
  }
  async createIfAbsent(i: { userId: string; memoryUsername: string }) {
    this.row ??= {
      userId: i.userId,
      memoryUsername: i.memoryUsername,
      status: 'creating',
      proxyCredentialId: null,
      proxyKey: null,
      displayName: null,
    };
    return this.row;
  }
  async saveProxyIfAbsent(_u: string, i: { credentialId: string; key: EncryptedSecret; displayName: string | null }) {
    Object.assign(this.row!, { proxyCredentialId: i.credentialId, proxyKey: i.key, displayName: i.displayName });
    return true;
  }
  async markReady() {
    this.row!.status = 'ready';
  }
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const keep = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 10 }))).join(' '));
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(keep)),
  ];
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return out.join('\n');
}

describe('canário: segredos da memória nunca aparecem em saída', () => {
  it('fluxo de criação, falhas e inspeção dos objetos', async () => {
    const fake = new FakeAiMemory(ROOT);
    const url = await fake.start();
    const admin = new MemoryAdminClient({ baseUrl: url, rootToken: Secret.of(ROOT) });
    const users = new MemoryUsers(admin, new Repo(), new AesSecretCipher(Buffer.alloc(32, 9).toString('base64')));
    const seen: unknown[] = [];
    const logger = new Logger('canary');

    const output = await capture(async () => {
      const r = await users.ensure('01a1db61-e0d4-7261-ae1d-0b563922fde5', 'Fulana');
      seen.push(r, users, admin);
      const issued = await admin.issueCredential(r.username, 'pc:aaaa:note');
      seen.push(issued, await admin.rotateCredential(issued.credential.id));
      fake.failNext = { path: /grant/, status: 500 };
      const err = await admin.grant(r.username, 'w', 'p', 'read').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MemoryAdminError);
      seen.push(err);
      logger.log(`ok ${err}`);
      logger.error(String(err));
      console.log(inspect(seen, { depth: 10, showHidden: true }));
      console.log(JSON.stringify(seen, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
    });

    const secrets = [ROOT, FAKE_TEMP_PASSWORD, ...fake.credentials.map((c) => c.token)];
    expect(secrets.length).toBeGreaterThan(2);
    for (const s of secrets) expect(output).not.toContain(s);
    await fake.stop();
  });
});
