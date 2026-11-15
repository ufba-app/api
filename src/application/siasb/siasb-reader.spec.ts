import { AcademicCalendar } from '../ports/academic-calendar';
import {
  SourceAccountRepository,
  type EncryptedSecret,
  type SourceAccountRecord,
  type UpsertSourceAccountInput,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, SiasbSession, SiasbSource } from '../ports/siasb-source';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from '../../domain/siasb/types';
import { InvalidPeriodError, ReconectarError, SiasbReader } from './siasb-reader';

const NOW = new Date('2026-11-16T12:00:00Z'); // segunda
const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);

function sess(id: string, disc: string, attendance: string, startIso: string, label = 'Confirmado'): ClinicalSession {
  const startAt = d(startIso);
  return {
    id,
    attendanceId: attendance,
    disciplineId: disc,
    disciplineName: `Disc ${disc}`,
    firstName: 'Ab',
    professorName: 'Prof',
    locationName: 'Sala',
    startAt,
    endAt: new Date(startAt.getTime() + 3_600_000),
    rescheduledStartAt: null,
    statusLabel: label,
  };
}

class FakeSiasb extends SiasbSource {
  calls: string[] = [];
  sessionRanges: { from: Date; to: Date }[] = [];
  failure: Error | null = null;
  renew = false;
  discs: ClinicalDiscipline[] = [];
  atts: ClinicalAttendance[] = [];
  inactiveAtts: ClinicalAttendance[] | null = null;
  sess: ClinicalSession[] = [];
  seenCookies: Record<string, string>[] = [];
  private touch(name: string, s: SiasbSession) {
    this.calls.push(name);
    this.seenCookies.push({ ...s.cookies });
    if (this.renew) {
      s.cookies = { ...s.cookies, fresh: 'novo' };
      s.expiresAt = new Date('2026-12-31T00:00:00Z');
      s.dirty = true;
    }
    if (this.failure) throw this.failure;
  }
  async courseOptions() {
    return [];
  }
  async login(): Promise<{ session: SiasbSession; username: string }> {
    throw new Error('no');
  }
  async disciplines(s: SiasbSession) {
    this.touch('disciplines', s);
    return this.discs;
  }
  async attendances(s: SiasbSession, status: 'active' | 'inactive' = 'active') {
    this.touch('attendances', s);
    return status === 'inactive' && this.inactiveAtts ? this.inactiveAtts : this.atts;
  }
  async sessions(s: SiasbSession, from: Date, to: Date) {
    this.touch('sessions', s);
    this.sessionRanges.push({ from, to });
    return this.sess;
  }
  async procedures() {
    return [];
  }
  async unassignedCount() {
    return {};
  }
}

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [];
  statuses: { id: string; status: string }[] = [];
  failUpdate = false;
  updates: { id: string; secret: EncryptedSecret; expiresAt?: Date }[] = [];
  async upsert(_i: UpsertSourceAccountInput): Promise<SourceAccountRecord> {
    throw new Error('no');
  }
  async findByUserAndProvider(userId: string, provider: string) {
    return this.rows.filter((r) => r.userId === userId && r.provider === provider);
  }
  async listByUser() {
    return [];
  }
  async setStatus(id: string, status: SourceAccountRecord['status']) {
    this.statuses.push({ id, status });
    this.rows.forEach((r) => r.id === id && (r.status = status));
  }
  async updateSecret(id: string, secret: EncryptedSecret, expiresAt?: Date) {
    if (this.failUpdate) throw new Error('P2025');
    this.updates.push({ id, secret, expiresAt });
  }
  async delete() {}
}

class FakeCipher extends SecretCipher {
  encrypt(plain: string): EncryptedSecret {
    return { ciphertext: plain, iv: 'iv', authTag: 'tag' };
  }
  decrypt(s: EncryptedSecret): string {
    return s.ciphertext;
  }
}

class FakeCalendar extends AcademicCalendar {
  constructor(public result: { known: boolean; dates: string[] } = { known: false, dates: [] }) {
    super();
  }
  async holidays() {
    return this.result;
  }
}

function setup(calendar = new FakeCalendar(), withAccount = true) {
  const siasb = new FakeSiasb();
  const accounts = new FakeAccounts();
  if (withAccount) {
    accounts.rows.push({
      id: 'acc1',
      userId: 'u1',
      provider: 'SIASB',
      accountKey: 'siasb',
      siteUrl: null,
      status: 'OK',
      lastSyncedAt: null,
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      secret: new FakeCipher().encrypt(JSON.stringify({ k: 'v' })),
    });
  }
  const reader = new SiasbReader(siasb, accounts, new FakeCipher(), calendar, () => NOW);
  return { siasb, accounts, reader };
}

describe('SiasbReader: sessão guardada e 401', () => {
  it('abre a sessão guardada e regrava o jar quando dirty', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.renew = true;
    await reader.sessions('u1');
    expect(siasb.seenCookies[0]).toEqual({ k: 'v' });
    expect(accounts.updates).toHaveLength(1);
    expect(JSON.parse(accounts.updates[0].secret.ciphertext)).toEqual({ k: 'v', fresh: 'novo' });
    expect(accounts.updates[0].expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('não regrava quando o jar não mudou', async () => {
    const { accounts, reader } = setup();
    await reader.sessions('u1');
    expect(accounts.updates).toHaveLength(0);
  });

  it('REAUTH_NEEDED no meio da leitura marca a conta e lança ReconectarError', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const err = await reader.sessions('u1').catch((e) => e);
    expect(err).toBeInstanceOf(ReconectarError);
    expect(err.code).toBe('reconectar');
    expect(err.message).toBe('Sua conexão com o SIASB expirou. Entre de novo no painel.');
    expect(accounts.statuses).toEqual([{ id: 'acc1', status: 'REAUTH_NEEDED' }]);
  });

  it('sem conta SIASB lança ReconectarError', async () => {
    const { reader } = setup(new FakeCalendar(), false);
    await expect(reader.situation('u1')).rejects.toBeInstanceOf(ReconectarError);
  });

  it('conta já em REAUTH_NEEDED lança sem chamar o SIASB', async () => {
    const { siasb, accounts, reader } = setup();
    accounts.rows[0].status = 'REAUTH_NEEDED';
    await expect(reader.sessions('u1')).rejects.toBeInstanceOf(ReconectarError);
    expect(siasb.calls).toEqual([]);
  });

  it('SIASB indisponível dá erro legível e não muda o status', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.failure = new SiasbError('UNAVAILABLE');
    const err = await reader.sessions('u1').catch((e) => e);
    expect(err).not.toBeInstanceOf(ReconectarError);
    expect(err.message).toBe('O SIASB não respondeu agora. Tente de novo em instantes.');
    expect(accounts.statuses).toEqual([]);
  });

  it('formato inesperado dá erro legível e não muda o status', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.failure = new SiasbError('UNEXPECTED_FORMAT');
    await expect(reader.sessions('u1')).rejects.toThrow(/SIASB/);
    expect(accounts.statuses).toEqual([]);
  });
});

describe('SiasbReader.sessions', () => {
  it('usa 14 dias como padrão', async () => {
    const { siasb, reader } = setup();
    await reader.sessions('u1');
    expect(siasb.sessionRanges[0]).toEqual({ from: NOW, to: new Date(NOW.getTime() + 14 * DAY) });
  });

  it('nunca pede além de 45 dias à frente', async () => {
    const { siasb, reader } = setup();
    await reader.sessions('u1', { from: NOW, to: new Date(NOW.getTime() + 200 * DAY) });
    expect(siasb.sessionRanges[0].to).toEqual(new Date(NOW.getTime() + 45 * DAY));
  });
});

describe('SiasbReader: limite do intervalo enviado ao SIASB (190 dias)', () => {
  const at = (days: number) => new Date(NOW.getTime() + days * DAY);

  it('sessions: 190 dias passa inteiro; 191 dias tem o início puxado para 190 dias antes do fim', async () => {
    const a = setup();
    await a.reader.sessions('u1', { from: at(-150), to: at(40) });
    expect(a.siasb.sessionRanges[0]).toEqual({ from: at(-150), to: at(40) });
    const b = setup();
    await b.reader.sessions('u1', { from: at(-151), to: at(40) });
    expect(b.siasb.sessionRanges[0]).toEqual({ from: at(-150), to: at(40) });
  });

  it('sessions: o fim ainda é limitado a agora+45 antes de contar os 190 dias', async () => {
    const { siasb, reader } = setup();
    await reader.sessions('u1', { from: at(-400), to: at(300) });
    expect(siasb.sessionRanges[0]).toEqual({ from: at(45 - 190), to: at(45) });
  });

  it('sessions: de > ate dá InvalidPeriodError e não chama o SIASB', async () => {
    const { siasb, reader } = setup();
    await expect(reader.sessions('u1', { from: at(5), to: at(1) })).rejects.toBeInstanceOf(InvalidPeriodError);
    expect(siasb.calls).toEqual([]);
  });

  it('sessions: período todo além de agora+45 devolve vazio sem chamar o SIASB', async () => {
    const { siasb, reader } = setup();
    await expect(reader.sessions('u1', { from: at(60), to: at(70) })).resolves.toEqual([]);
    expect(siasb.calls).toEqual([]);
  });

  it('progress: de > ate dá InvalidPeriodError', async () => {
    const { siasb, reader } = setup();
    await expect(reader.progress('u1', { from: at(5), to: at(1) })).rejects.toBeInstanceOf(InvalidPeriodError);
    expect(siasb.calls).toEqual([]);
  });

  it('progress: período de 190 dias que termina antes de agora+45 estende só até 190 dias do início', async () => {
    const { siasb, reader } = setup();
    await reader.progress('u1', { from: at(-190), to: at(0) });
    expect(siasb.sessionRanges[0]).toEqual({ from: at(-190), to: at(0) });
    const s = setup();
    await s.reader.progress('u1', { from: at(-150), to: at(-10) });
    expect(s.siasb.sessionRanges[0]).toEqual({ from: at(-150), to: at(40) });
  });

  it('progress: período futuro (to além de agora+45) não é estendido', async () => {
    const { siasb, reader } = setup();
    await reader.progress('u1', { from: at(50), to: at(100) });
    expect(siasb.sessionRanges[0]).toEqual({ from: at(50), to: at(100) });
  });

  it('progress: nenhuma chamada passa de 190 dias, mesmo com período maior que o teto', async () => {
    const { siasb, reader } = setup();
    await reader.progress('u1', { from: at(-300), to: at(-1) });
    const r = siasb.sessionRanges[0];
    expect((r.to.getTime() - r.from.getTime()) / DAY).toBeLessThanOrEqual(190);
  });

  it('progress padrão: 120 dias atrás até agora+45', async () => {
    const { siasb, reader } = setup();
    await reader.progress('u1');
    expect(siasb.sessionRanges[0]).toEqual({ from: at(-120), to: at(45) });
  });
});

describe('SiasbReader.situation', () => {
  function fixture(s: ReturnType<typeof setup>) {
    s.siasb.discs = [
      { id: '1', name: 'Disc 1' },
      { id: '2', name: 'Disc 2' },
      { id: '3', name: 'Disc 3' },
    ];
    s.siasb.atts = [
      { id: 'a2', disciplineId: '2', firstName: 'Ab', treatmentType: 'PLANNING', concluded: false },
      { id: 'a3', disciplineId: '3', firstName: 'Cd', treatmentType: 'PLANNING', concluded: false },
    ];
    s.siasb.sess = [
      // disciplina 3: sextas 10h (Bahia) atendidas e uma marcada no futuro
      sess('s1', '3', 'a3', '2026-11-06T13:00:00Z', 'Atendido'),
      sess('s2', '3', 'a3', '2026-11-13T13:00:00Z', 'Atendido'),
      sess('s3', '3', 'a3', '2026-11-27T13:00:00Z', 'Confirmado'),
      // canceladas não criam slot
      sess('s4', '2', 'a2', '2026-11-10T13:00:00Z', 'Cancelado'),
      sess('s5', '2', 'a2', '2026-11-17T13:00:00Z', 'Cancelado'),
    ];
  }

  it('dá NO_PATIENT, NO_SESSION e SCHEDULED, com deadline só quando há horário conhecido', async () => {
    const s = setup();
    fixture(s);
    const r = await s.reader.situation('u1');
    const by = Object.fromEntries(r.map((x) => [x.disciplineId, x]));
    expect(by['1']).toMatchObject({ state: 'NO_PATIENT', nextSlot: null, deadline: null, estimated: true });
    expect(by['2']).toMatchObject({ state: 'NO_SESSION', nextSlot: null, deadline: null, estimated: true });
    expect(by['3'].state).toBe('SCHEDULED');
    expect(by['3'].nextSlot).toEqual(d('2026-11-20T13:00:00Z'));
    expect(by['3'].deadline).toBeInstanceOf(Date);
    expect(by['3'].estimated).toBe(true);
    expect(by['3'].holidaysConsidered).toBe(false);
  });

  it('faz no máximo 3 chamadas ao SIASB e uma só de sessions (60 atrás, 45 à frente)', async () => {
    const s = setup();
    fixture(s);
    await s.reader.situation('u1');
    expect(s.siasb.calls).toEqual(['disciplines', 'attendances', 'sessions']);
    expect(s.siasb.sessionRanges[0]).toEqual({
      from: new Date(NOW.getTime() - 60 * DAY),
      to: new Date(NOW.getTime() + 45 * DAY),
    });
  });
});

describe('SiasbReader.bookingDeadline e feriados', () => {
  const FRI = d('2026-11-27T13:00:00Z'); // sexta 10h Bahia

  it('com calendário conhecido: terça 24 10h e holidaysConsidered true', async () => {
    const s = setup(new FakeCalendar({ known: true, dates: ['2026-11-25'] }));
    const r = await s.reader.bookingDeadline('u1', { sessionStart: FRI });
    expect(r.deadline).toEqual(d('2026-11-24T13:00:00Z'));
    expect(r.estimated).toBe(true);
    expect(r.holidaysConsidered).toBe(true);
  });

  it('sem calendário: 1 dia útil de margem, terça 24 10h e holidaysConsidered false', async () => {
    const s = setup(new FakeCalendar({ known: false, dates: [] }));
    const r = await s.reader.bookingDeadline('u1', { sessionStart: FRI });
    expect(r.deadline).toEqual(d('2026-11-24T13:00:00Z'));
    expect(r.holidaysConsidered).toBe(false);
  });

  it('por disciplina usa o próximo horário conhecido; sem horário dá erro em pt-BR', async () => {
    const s = setup();
    s.siasb.sess = [
      sess('s1', '3', 'a3', '2026-11-06T13:00:00Z', 'Atendido'),
      sess('s2', '3', 'a3', '2026-11-13T13:00:00Z', 'Atendido'),
    ];
    // próximo slot: sexta 20/11 10h; 2 úteis + 1 de margem para trás: terça 17/11 10h
    const ok = await s.reader.bookingDeadline('u1', { disciplineId: '3' });
    expect(ok.deadline).toEqual(d('2026-11-17T13:00:00Z'));
    await expect(s.reader.bookingDeadline('u1', { disciplineId: '1' })).rejects.toThrow(/horário/);
  });
});

describe('SiasbReader: regravação do jar e erros', () => {
  it('401 com jar dirty não regrava o jar', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.renew = true;
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    await expect(reader.sessions('u1')).rejects.toBeInstanceOf(ReconectarError);
    expect(accounts.updates).toHaveLength(0);
  });

  it('falha ao regravar não troca o resultado da leitura', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.renew = true;
    siasb.sess = [sess('s1', '3', 'a3', '2026-11-20T13:00:00Z')];
    accounts.failUpdate = true;
    await expect(reader.sessions('u1')).resolves.toHaveLength(1);
  });

  it('falha ao regravar não troca o erro original da leitura', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.renew = true;
    siasb.failure = new SiasbError('UNAVAILABLE');
    accounts.failUpdate = true;
    await expect(reader.sessions('u1')).rejects.toThrow('O SIASB não respondeu agora');
  });

  it('jar guardado corrompido vira REAUTH_NEEDED sem vazar conteúdo', async () => {
    const { siasb, accounts, reader } = setup();
    accounts.rows[0].secret = { ciphertext: 'segredo-cookie{', iv: 'iv', authTag: 'tag' };
    const err = await reader.sessions('u1').catch((e) => e);
    expect(err).toBeInstanceOf(ReconectarError);
    expect(err.message).not.toContain('segredo-cookie');
    expect(accounts.statuses).toEqual([{ id: 'acc1', status: 'REAUTH_NEEDED' }]);
    expect(siasb.calls).toEqual([]);
  });

  it('erro que não é do SIASB é relançado como está', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.failure = new Error('boom');
    const err = await reader.sessions('u1').catch((e) => e);
    expect(err).not.toBeInstanceOf(ReconectarError);
    expect(err.message).toBe('boom');
    expect(accounts.statuses).toEqual([]);
  });
});

describe('SiasbReader: estado e prazo vencido', () => {
  const att = { id: 'a2', disciplineId: '2', firstName: 'Ab', treatmentType: 'PLANNING' as const, concluded: false };

  it('Confirmado passada e Atendido futura não dão SCHEDULED', async () => {
    const s = setup();
    s.siasb.discs = [{ id: '2', name: 'Disc 2' }];
    s.siasb.atts = [att];
    s.siasb.sess = [
      sess('s1', '2', 'a2', '2026-11-10T13:00:00Z', 'Confirmado'),
      sess('s2', '2', 'a2', '2026-11-20T13:00:00Z', 'Atendido'),
    ];
    const [r] = await s.reader.situation('u1');
    expect(r.state).toBe('NO_SESSION');
  });

  function wednesdays(s: ReturnType<typeof setup>) {
    s.siasb.discs = [{ id: '2', name: 'Disc 2' }];
    s.siasb.atts = [att];
    s.siasb.sess = [
      sess('s1', '2', 'a2', '2026-11-04T13:00:00Z', 'Atendido'),
      sess('s2', '2', 'a2', '2026-11-11T13:00:00Z', 'Atendido'),
    ];
  }

  it('situation usa o horário da semana seguinte quando o prazo do próximo já passou', async () => {
    const s = setup();
    wednesdays(s);
    const [r] = await s.reader.situation('u1');
    // quarta 18/11 10h teria prazo sexta 13/11 (passado); vale quarta 25/11, prazo sexta 20/11 10h
    expect(r.nextSlot).toEqual(d('2026-11-25T13:00:00Z'));
    expect(r.deadline).toEqual(d('2026-11-20T13:00:00Z'));
  });

  it('bookingDeadline por disciplina segue a mesma regra', async () => {
    const s = setup();
    wednesdays(s);
    const r = await s.reader.bookingDeadline('u1', { disciplineId: '2' });
    expect(r.deadline).toEqual(d('2026-11-20T13:00:00Z'));
  });

  it('bookingDeadline por sessionStart é literal, mesmo no passado', async () => {
    const s = setup();
    const r = await s.reader.bookingDeadline('u1', { sessionStart: d('2026-11-18T13:00:00Z') });
    expect(r.deadline).toEqual(d('2026-11-13T13:00:00Z'));
  });
});

describe('SiasbReader.snapshot', () => {
  const att = (id: string, disciplineId: string, concluded = false): ClinicalAttendance => ({
    id,
    disciplineId,
    firstName: 'Ab',
    treatmentType: 'PLANNING',
    concluded,
  });

  it('devolve atendimentos ativos e inativos com o nome da disciplina e as sessões da janela', async () => {
    const { siasb, reader } = setup();
    siasb.discs = [{ id: '2', name: 'Clínica 2' } as ClinicalDiscipline];
    siasb.atts = [att('a1', '2')];
    siasb.inactiveAtts = [att('a9', '2', true)];
    siasb.sess = [sess('s1', '2', 'a1', '2026-11-10T13:00:00Z')];
    const snap = await reader.snapshot('u1');
    expect(snap.attendances.map((a) => [a.id, a.disciplineName])).toEqual([
      ['a1', 'Clínica 2'],
      ['a9', 'Clínica 2'],
    ]);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.window).toEqual({ from: new Date(NOW.getTime() - 120 * DAY), to: new Date(NOW.getTime() + 45 * DAY) });
  });

  it('chama sessions uma só vez, de agora-120 a agora+45 dias, e grava o jar uma vez', async () => {
    const { siasb, accounts, reader } = setup();
    siasb.renew = true;
    await reader.snapshot('u1');
    expect(siasb.sessionRanges).toEqual([
      { from: new Date(NOW.getTime() - 120 * DAY), to: new Date(NOW.getTime() + 45 * DAY) },
    ]);
    expect(accounts.updates).toHaveLength(1);
  });

  it('sem conta SIASB lança ReconectarError', async () => {
    const { reader } = setup(new FakeCalendar(), false);
    await expect(reader.snapshot('u1')).rejects.toBeInstanceOf(ReconectarError);
  });

  it('atendimento de disciplina desconhecida fica com disciplineName vazio', async () => {
    const { siasb, reader } = setup();
    siasb.discs = [];
    siasb.atts = [att('a1', '99')];
    const snap = await reader.snapshot('u1');
    expect(snap.attendances[0].disciplineName).toBe('');
  });
});
