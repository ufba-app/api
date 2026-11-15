import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import type { SecretCipher } from '../ports/secret-cipher';
import type { SyncedAttendance, SyncedSession } from '../ports/siasb-copy';
import { STALE_AFTER_MS, SiasbCopyReader } from './siasb-copy-reader';

/** Cifra falsa e reversível (sem AES, para respeitar a regra de camadas). */
class FakeCipher implements SecretCipher {
  encrypt(plain: string, aad = '') {
    return { ciphertext: Buffer.from(JSON.stringify([plain, aad])).toString('base64'), iv: 'iv', authTag: 'tag' };
  }
  decrypt(secret: { ciphertext: string }, aad = '') {
    const [plain, used] = JSON.parse(Buffer.from(secret.ciphertext, 'base64').toString());
    if (used !== aad) throw new Error('aad');
    return plain as string;
  }
}

const NOW = new Date('2026-11-15T12:00:00Z');
const cipher = new FakeCipher();
const NOME = 'Zeferina';

const attendance = (userId: string, id: string, firstName = NOME): SyncedAttendance => ({
  id,
  disciplineId: 'd1',
  disciplineName: 'Clinica 1',
  treatmentType: 'PLANNING',
  concluded: false,
  firstName: cipher.encrypt(firstName, `siasb-attendance:${userId}:${id}`),
});

const session = (id: string, attendanceId: string, startAt: string): SyncedSession => ({
  id,
  attendanceId,
  disciplineId: 'd1',
  disciplineName: 'Clinica 1',
  professorName: 'Profa. Teste',
  locationName: 'Sala 1',
  startAt: new Date(startAt),
  endAt: new Date(new Date(startAt).getTime() + 3_600_000),
  rescheduledStartAt: null,
  statusLabel: 'Agendada',
});

async function setup(now = NOW) {
  const copy = new InMemorySiasbCopy();
  copy.accounts.set('u1', 'OK');
  copy.accounts.set('u2', 'OK');
  await copy.replaceWindow(
    'u1',
    { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') },
    {
      attendances: [attendance('u1', 'a1')],
      sessions: [
        session('s2', 'a1', '2026-11-20T14:00:00Z'),
        session('s1', 'a1', '2026-11-16T14:00:00Z'),
        session('s3', 'a1', '2026-12-20T14:00:00Z'),
        session('s4', 'sumiu', '2026-11-17T14:00:00Z'),
      ],
    },
  );
  copy.seedState('u1');
  await copy.recordAttempt('u1', { result: 'OK', at: new Date(now.getTime() - 60_000), nextRunAt: null });
  return { copy, reader: new SiasbCopyReader(copy, cipher, () => now) };
}

const FROM = new Date('2026-11-10T00:00:00Z');
const TO = new Date('2026-11-30T00:00:00Z');

describe('SiasbCopyReader.calendar', () => {
  it('itens ordenados e filtrados pelo intervalo, com o primeiro nome decifrado', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.items.map((i) => i.id)).toEqual(['s1', 's4', 's2']);
    expect(r.items[0].patientFirstName).toBe(NOME);
    expect(r.items[0].attendanceId).toBe('a1');
    expect(r.items[0].rescheduledStartAt).toBeNull();
  });

  it('atendimento da sessão sumiu: nome vazio, sem lançar', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.items.find((i) => i.id === 's4')!.patientFirstName).toBe('');
  });

  it('só o dono: outro userId não vê o item nem o nome', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u2', FROM, TO);
    expect(r.items).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(NOME);
  });

  it('decifra falha: nome vazio e não lança', async () => {
    const { copy } = await setup();
    const broken = new SiasbCopyReader(
      copy,
      {
        encrypt: cipher.encrypt.bind(cipher),
        decrypt: () => {
          throw new Error(`falha com ${NOME}`);
        },
      },
      () => NOW,
    );
    const r = await broken.calendar('u1', FROM, TO);
    expect(r.items).toHaveLength(3);
    expect(r.items.every((i) => i.patientFirstName === '')).toBe(true);
  });

  it('syncedAt e stale falso quando o último resultado é OK e recente', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.syncedAt).toEqual(new Date(NOW.getTime() - 60_000));
    expect(r.stale).toBe(false);
  });

  it('stale: sem estado', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u2', FROM, TO);
    expect(r.syncedAt).toBeNull();
    expect(r.stale).toBe(true);
  });

  it('stale: último resultado diferente de OK', async () => {
    const { copy, reader } = await setup();
    copy.seedState('u1');
    await copy.recordAttempt('u1', { result: 'UNAVAILABLE', at: new Date(NOW.getTime() - 1000), nextRunAt: null });
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.stale).toBe(true);
    expect(r.syncedAt).toEqual(new Date(NOW.getTime() - 60_000));
  });

  it('stale: último sucesso mais velho que 3 h', async () => {
    const { copy } = await setup();
    const later = new SiasbCopyReader(copy, cipher, () => new Date(NOW.getTime() + STALE_AFTER_MS));
    expect((await later.calendar('u1', FROM, TO)).stale).toBe(true);
  });
});
