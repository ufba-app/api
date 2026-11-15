import { InMemorySiasbCopy } from './siasb-copy-fake';
import type { SyncedAttendance, SyncedSession } from '../../src/application/ports/siasb-copy';

const U = 'user-1';
const d = (iso: string) => new Date(iso);
const att = (id: string): SyncedAttendance => ({
  id,
  disciplineId: 'd1',
  disciplineName: 'Disciplina Teste',
  treatmentType: 'TRIAGE',
  concluded: false,
  firstName: { ciphertext: 'Y2lwaGVy', iv: 'aXY=', authTag: 'dGFn' },
});
const ses = (id: string, startAt: string): SyncedSession => ({
  id,
  attendanceId: 'a1',
  disciplineId: 'd1',
  disciplineName: 'Disciplina Teste',
  professorName: 'Docente Teste',
  locationName: 'Sala 1',
  startAt: d(startAt),
  endAt: d(startAt),
  rescheduledStartAt: null,
  statusLabel: 'Agendada',
});
const W = { from: d('2026-11-10T00:00:00Z'), to: d('2026-11-20T00:00:00Z') };
const ALL = { from: d('2026-01-01T00:00:00Z'), to: d('2026-12-31T00:00:00Z') };

describe('InMemorySiasbCopy', () => {
  let repo: InMemorySiasbCopy;
  beforeEach(() => {
    repo = new InMemorySiasbCopy();
    repo.accounts.set(U, 'OK');
  });

  it('replaceWindow: sessões fora da janela sobrevivem; as de dentro ausentes do novo conjunto somem', async () => {
    await repo.replaceWindow(U, W, {
      attendances: [att('a1')],
      sessions: [
        ses('old', '2026-11-01T10:00:00Z'),
        ses('gone', '2026-11-12T10:00:00Z'),
        ses('keep', '2026-11-13T10:00:00Z'),
      ],
    });
    await repo.replaceWindow(U, W, {
      attendances: [att('a2')],
      sessions: [ses('keep', '2026-11-13T11:00:00Z'), ses('new', '2026-11-15T10:00:00Z')],
    });
    const out = await repo.sessions(U, ALL.from, ALL.to);
    expect(out.map((s) => s.id)).toEqual(['old', 'keep', 'new']);
    expect(out[1].startAt).toEqual(d('2026-11-13T11:00:00Z'));
    expect((await repo.attendances(U)).map((a) => a.id)).toEqual(['a2']);
  });

  it('sessions: filtra pela janela e ordena por startAt', async () => {
    await repo.replaceWindow(U, W, {
      attendances: [],
      sessions: [ses('b', '2026-11-15T10:00:00Z'), ses('a', '2026-11-11T10:00:00Z')],
    });
    expect((await repo.sessions(U, d('2026-11-12T00:00:00Z'), W.to)).map((s) => s.id)).toEqual(['b']);
    expect((await repo.sessions(U, W.from, W.to)).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('replaceWindow: false e nada gravado sem conta SIASB', async () => {
    repo.accounts.delete(U);
    await expect(
      repo.replaceWindow(U, W, {
        attendances: [att('a1')],
        sessions: [ses('s', '2026-11-12T10:00:00Z')],
      }),
    ).resolves.toBe(false);
    expect(await repo.attendances(U)).toEqual([]);
    expect(await repo.sessions(U, W.from, W.to)).toEqual([]);
  });

  it('claim: busy enquanto a trava vale; claimed depois do prazo ou do release', async () => {
    const t0 = d('2026-11-15T12:00:00Z');
    expect(await repo.claim(U, t0, 60_000)).toBe('claimed');
    expect(await repo.claim(U, new Date(t0.getTime() + 30_000), 60_000)).toBe('busy');
    expect(await repo.claim(U, new Date(t0.getTime() + 61_000), 60_000)).toBe('claimed');
    await repo.release(U);
    expect(await repo.claim(U, new Date(t0.getTime() + 62_000), 60_000)).toBe('claimed');
  });

  it('claim: sem conta e sem linha é no_account e não cria estado; recordAttempt sem linha não faz nada', async () => {
    const t0 = d('2026-11-15T12:00:00Z');
    expect(await repo.claim('ghost', t0, 60_000)).toBe('no_account');
    await repo.recordAttempt('ghost', { result: 'OK', at: t0, nextRunAt: null });
    expect(await repo.state('ghost')).toBeNull();
  });

  it('dueUsers: ignora REAUTH_NEEDED, respeita limit, ordena por nextRunAt e inclui quem não tem estado', async () => {
    const now = d('2026-11-15T12:00:00Z');
    repo.accounts.set('u-reauth', 'REAUTH_NEEDED');
    repo.accounts.set('u-late', 'OK');
    repo.accounts.set('u-future', 'OK');
    repo.accounts.set('u-early', 'OK');
    for (const u of ['u-late', 'u-early', 'u-future', 'u-reauth']) repo.seedState(u);
    await repo.recordAttempt('u-late', {
      result: 'OK',
      at: now,
      nextRunAt: d('2026-11-15T11:00:00Z'),
    });
    await repo.recordAttempt('u-early', {
      result: 'OK',
      at: now,
      nextRunAt: d('2026-11-15T10:00:00Z'),
    });
    await repo.recordAttempt('u-future', {
      result: 'OK',
      at: now,
      nextRunAt: d('2026-11-15T13:00:00Z'),
    });
    await repo.recordAttempt('u-reauth', {
      result: 'OK',
      at: now,
      nextRunAt: d('2026-11-15T09:00:00Z'),
    });
    expect(await repo.dueUsers(now, 10)).toEqual([U, 'u-early', 'u-late']);
    expect(await repo.dueUsers(now, 2)).toEqual([U, 'u-early']);
  });

  it('dueUsers: nextRunAt nulo conta como devido se a conta está OK (reconexão), mas não com REAUTH_NEEDED', async () => {
    const now = d('2026-11-15T12:00:00Z');
    repo.accounts.set('u-rc', 'OK');
    repo.accounts.set('u-rc-reauth', 'REAUTH_NEEDED');
    repo.accounts.set('u-lock', 'OK');
    for (const u of ['u-rc', 'u-rc-reauth']) {
      await repo.claim(u, now, 60_000);
      await repo.recordAttempt(u, { result: 'RECONNECT_REQUIRED', at: now, nextRunAt: null });
      await repo.release(u);
    }
    await repo.claim('u-lock', now, 60_000);
    const due = await repo.dueUsers(now, 10);
    expect(due).toContain('u-rc');
    expect(due).toContain('u-lock');
    expect(due).not.toContain('u-rc-reauth');
  });

  it('deleteAll apaga cópia e estado', async () => {
    await repo.replaceWindow(U, W, {
      attendances: [att('a1')],
      sessions: [ses('s', '2026-11-12T10:00:00Z')],
    });
    repo.seedState(U);
    await repo.recordAttempt(U, { result: 'OK', at: W.from, nextRunAt: null });
    await repo.deleteAll(U);
    expect(await repo.attendances(U)).toEqual([]);
    expect(await repo.sessions(U, W.from, W.to)).toEqual([]);
    expect(await repo.state(U)).toBeNull();
  });

  it('recordAttempt: OK grava lastSuccessAt; falha não o apaga', async () => {
    const t1 = d('2026-11-15T10:00:00Z');
    const t2 = d('2026-11-15T11:00:00Z');
    repo.seedState(U);
    await repo.recordAttempt(U, { result: 'OK', at: t1, nextRunAt: t2 });
    await repo.recordAttempt(U, {
      result: 'UNAVAILABLE',
      at: t2,
      nextRunAt: null,
    });
    expect(await repo.state(U)).toEqual({
      lastAttemptAt: t2,
      lastSuccessAt: t1,
      result: 'UNAVAILABLE',
      nextRunAt: null,
    });
  });
});
