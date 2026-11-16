import { Logger } from '@nestjs/common';
import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import { inspect } from 'node:util';
import type { SecretCipher } from '../ports/secret-cipher';
import { ReconectarError, SiasbReadError, type SiasbReader } from './siasb-reader';
import { SYNC_INTERVAL_MS, SYNC_LEASE_MS, SYNC_RETRY_MS, SiasbSyncer } from './siasb-syncer';

/** Mesmo padrão de test/secret-canary.spec.ts (não importado: importar o spec rodaria os testes dele aqui). */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const keep = (...a: unknown[]) =>
    void out.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 10 }))).join(' '));
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

/** Cifra falsa e reversível: guarda o texto em base64 junto do aad (sem AES, para respeitar a regra de camadas). */
class FakeCipher implements SecretCipher {
  encrypt(plain: string, aad = '') {
    return {
      ciphertext: Buffer.from(JSON.stringify([plain, aad])).toString('base64'),
      iv: 'iv',
      authTag: 'tag',
    };
  }
  decrypt(secret: { ciphertext: string }, aad = '') {
    const [plain, used] = JSON.parse(Buffer.from(secret.ciphertext, 'base64').toString());
    if (used !== aad) throw new Error('aad');
    return plain as string;
  }
}

const NOW = new Date('2026-11-15T12:00:00Z');
const USER = 'u1';
const WINDOW = {
  from: new Date('2026-07-17T12:00:00Z'),
  to: new Date('2026-12-30T12:00:00Z'),
};
const NOME = 'Zeferina';

const snap = (firstName = NOME) => ({
  window: WINDOW,
  disciplines: [
    { id: 'd1', name: 'Clinica 1' },
    { id: 'd2', name: 'Clinica 2' },
  ],
  attendances: [
    {
      id: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clinica 1',
      firstName,
      treatmentType: 'PLANNING' as const,
      concluded: false,
      active: true,
    },
  ],
  sessions: [
    {
      id: 's1',
      attendanceId: 'a1',
      disciplineId: 'd1',
      disciplineName: 'Clinica 1',
      firstName,
      professorName: 'Prof',
      locationName: 'Sala',
      startAt: new Date('2026-11-20T12:00:00Z'),
      endAt: new Date('2026-11-20T13:00:00Z'),
      rescheduledStartAt: null,
      statusLabel: 'Marcado',
    },
  ],
});

function setup(snapshot: () => Promise<unknown> | unknown) {
  const reader = { snapshot: jest.fn(async () => snapshot()) };
  const copy = new InMemorySiasbCopy();
  copy.accounts.set(USER, 'OK');
  const cipher = new FakeCipher();
  const syncer = new SiasbSyncer(reader as unknown as SiasbReader, copy, cipher, () => NOW);
  return { reader, copy, cipher, syncer };
}

describe('SiasbSyncer', () => {
  it('sucesso: grava a cópia, cifra o nome e agenda +45 min', async () => {
    const { copy, cipher, syncer } = setup(() => snap());
    expect(await syncer.syncUser(USER)).toBe('OK');
    const [att] = await copy.attendances(USER);
    expect(JSON.stringify(att)).not.toContain(NOME);
    expect(cipher.decrypt(att.firstName, `siasb-attendance:${USER}:a1`)).toBe(NOME);
    const sessions = await copy.sessions(USER, WINDOW.from, WINDOW.to);
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(NOME);
    expect(await copy.state(USER)).toMatchObject({
      result: 'OK',
      lastSuccessAt: NOW,
      nextRunAt: new Date(NOW.getTime() + SYNC_INTERVAL_MS),
    });
    // trava liberada
    expect(await copy.claim(USER, NOW, SYNC_LEASE_MS)).toBe('claimed');
  });

  it('grava a origem ativo/inativo do atendimento sem cifrar', async () => {
    const base = snap();
    const { copy, syncer } = setup(() => ({
      ...base,
      attendances: [
        base.attendances[0],
        { ...base.attendances[0], id: 'a2', active: false, concluded: false },
      ],
    }));
    expect(await syncer.syncUser(USER)).toBe('OK');
    const rows = await copy.attendances(USER);
    expect(rows.map((a) => [a.id, a.active])).toEqual([
      ['a1', true],
      ['a2', false],
    ]);
  });

  it('grava as disciplinas do snapshot; sincronização seguinte com uma a menos a remove', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    expect(await syncer.syncUser(USER)).toBe('OK');
    expect(await copy.disciplines(USER)).toEqual([
      { id: 'd1', name: 'Clinica 1' },
      { id: 'd2', name: 'Clinica 2' },
    ]);
    reader.snapshot.mockResolvedValueOnce({ ...snap(), disciplines: [{ id: 'd2', name: 'Clinica 2' }] });
    expect(await syncer.syncUser(USER)).toBe('OK');
    expect(await copy.disciplines(USER)).toEqual([{ id: 'd2', name: 'Clinica 2' }]);
  });

  it('firstName vazio é cifrado e não quebra', async () => {
    const { copy, cipher, syncer } = setup(() => snap(''));
    expect(await syncer.syncUser(USER)).toBe('OK');
    const [att] = await copy.attendances(USER);
    expect(cipher.decrypt(att.firstName, `siasb-attendance:${USER}:a1`)).toBe('');
  });

  it('SIASB fora do ar não apaga nada e agenda +15 min', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    await syncer.syncUser(USER);
    reader.snapshot.mockRejectedValueOnce(new SiasbReadError('siasb_unavailable'));
    expect(await syncer.syncUser(USER)).toBe('UNAVAILABLE');
    expect(await copy.attendances(USER)).toHaveLength(1);
    expect(await copy.sessions(USER, WINDOW.from, WINDOW.to)).toHaveLength(1);
    expect(await copy.state(USER)).toMatchObject({
      result: 'UNAVAILABLE',
      lastSuccessAt: NOW,
      nextRunAt: new Date(NOW.getTime() + SYNC_RETRY_MS),
    });
  });

  it('erro inesperado também vira UNAVAILABLE com +15 min', async () => {
    const { copy, syncer } = setup(() => {
      throw new Error('boom');
    });
    expect(await syncer.syncUser(USER)).toBe('UNAVAILABLE');
    expect((await copy.state(USER))?.nextRunAt).toEqual(new Date(NOW.getTime() + SYNC_RETRY_MS));
  });

  it('ReconectarError mantém a cópia e grava RECONNECT_REQUIRED sem nextRunAt', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    await syncer.syncUser(USER);
    reader.snapshot.mockRejectedValueOnce(new ReconectarError());
    expect(await syncer.syncUser(USER)).toBe('RECONNECT_REQUIRED');
    expect(await copy.attendances(USER)).toHaveLength(1);
    expect(await copy.state(USER)).toMatchObject({
      result: 'RECONNECT_REQUIRED',
      nextRunAt: null,
    });
  });

  it('RECONNECT_REQUIRED e depois reconexão (conta OK, sem sincronização inicial): dueUsers devolve a pessoa', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    reader.snapshot.mockRejectedValueOnce(new ReconectarError());
    expect(await syncer.syncUser(USER)).toBe('RECONNECT_REQUIRED');
    copy.accounts.set(USER, 'REAUTH_NEEDED');
    expect(await copy.dueUsers(NOW, 10)).toEqual([]);
    copy.accounts.set(USER, 'OK');
    expect(await copy.dueUsers(NOW, 10)).toEqual([USER]);
  });

  it('claim ocupado: BUSY e o leitor não é chamado', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    await copy.claim(USER, NOW, SYNC_LEASE_MS);
    expect(await syncer.syncUser(USER)).toBe('BUSY');
    expect(reader.snapshot).not.toHaveBeenCalled();
    expect((await copy.state(USER))?.result).toBeNull();
  });

  it('desconexão no meio (replaceWindow false): DISCONNECTED sem recordAttempt', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    reader.snapshot.mockImplementationOnce(async () => {
      copy.accounts.delete(USER);
      return snap();
    });
    const spy = jest.spyOn(copy, 'recordAttempt');
    expect(await syncer.syncUser(USER)).toBe('DISCONNECTED');
    expect(spy).not.toHaveBeenCalled();
    expect(await copy.attendances(USER)).toHaveLength(0);
  });

  it('a trava é liberada mesmo quando o leitor lança', async () => {
    const { copy, syncer } = setup(() => {
      throw new Error('x');
    });
    await syncer.syncUser(USER);
    expect(await copy.claim(USER, NOW, SYNC_LEASE_MS)).toBe('claimed');
  });

  it('sem conta SIASB: DISCONNECTED, sem ler e sem criar linha de estado', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    copy.accounts.delete(USER);
    const rec = jest.spyOn(copy, 'recordAttempt');
    expect(await syncer.syncUser(USER)).toBe('DISCONNECTED');
    expect(reader.snapshot).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
    expect(await copy.state(USER)).toBeNull();
  });

  it('erro genérico de claim escapa de syncUser (não vira DISCONNECTED)', async () => {
    const { reader, copy, syncer } = setup(() => snap());
    jest.spyOn(copy, 'claim').mockRejectedValue(new Error('db down'));
    await expect(syncer.syncUser(USER)).rejects.toThrow('db down');
    expect(reader.snapshot).not.toHaveBeenCalled();
  });

  it('recordAttempt que lança nunca escapa e a trava é liberada', async () => {
    const { copy, syncer } = setup(() => snap());
    jest.spyOn(copy, 'recordAttempt').mockRejectedValue(new Error('FK'));
    const release = jest.spyOn(copy, 'release');
    await expect(syncer.syncUser(USER)).resolves.toBe('OK');
    expect(release).toHaveBeenCalledWith(USER);
  });

  it('release que lança também é engolido', async () => {
    const { copy, syncer } = setup(() => snap());
    jest.spyOn(copy, 'release').mockRejectedValue(new Error('FK'));
    await expect(syncer.syncUser(USER)).resolves.toBe('OK');
  });

  it('replaceWindow que lança vira UNAVAILABLE e não escapa', async () => {
    const { copy, syncer } = setup(() => snap());
    jest.spyOn(copy, 'replaceWindow').mockRejectedValue(new Error('db'));
    await expect(syncer.syncUser(USER)).resolves.toBe('UNAVAILABLE');
  });

  it('canário: o nome do paciente numa mensagem de erro nunca aparece em log', async () => {
    const { syncer } = setup(() => {
      throw new Error(`falha com paciente ${NOME}`);
    });
    const seen = await captureOutput(async () => {
      Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
      await syncer.syncUser(USER);
    });
    Logger.overrideLogger(false);
    expect(seen).not.toContain(NOME);
  });
});
