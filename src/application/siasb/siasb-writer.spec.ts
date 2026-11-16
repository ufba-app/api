import { Logger } from '@nestjs/common';
import { InMemorySiasbWriteAudit } from '../../../test/support/siasb-write-audit-fake';
import type { ClinicalAttendance, ClinicalSession, Procedure } from '../../domain/siasb/types';
import type { SyncOutcome } from '../jobs/sync-provider';
import {
  SourceAccountRepository,
  type EncryptedSecret,
  type SourceAccountRecord,
  type UpsertSourceAccountInput,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import {
  SiasbError,
  SiasbSession,
  SiasbSource,
  type ScheduleSessionsInput,
  type SchedulingOptions,
  type WriteResult,
} from '../ports/siasb-source';
import { ReconectarError, SiasbReadError, SiasbSessionRunner } from './siasb-session-runner';
import { SiasbWriter, WriteFailedError, WriteInputError } from './siasb-writer';

const NOW = new Date('2026-11-16T12:00:00Z'); // segunda, 9h na Bahia
const START = new Date('2026-11-20T13:00:00Z'); // sexta, 20/11/2026, 10h na Bahia
const WEEK = 7 * 86_400_000;
const PACIENTE = 'Zuleica Paciente-Canario';
/** Como o writer devolve horários: hora da Bahia com -03:00. */
const bahiaIso = (d: Date) => `${new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [
    {
      id: 'acc1',
      userId: 'u1',
      provider: 'SIASB',
      accountKey: 'siasb',
      siteUrl: null,
      status: 'OK',
      lastSyncedAt: null,
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      secret: { ciphertext: JSON.stringify({ k: 'v' }), iv: 'iv', authTag: 'tag' },
    },
  ];
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
    this.rows.forEach((r) => r.id === id && (r.status = status));
  }
  async updateSecret() {}
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

const att = (id: string, disciplineId = 'd1'): ClinicalAttendance => ({
  id,
  disciplineId,
  firstName: 'Zuleica',
  treatmentType: 'PLANNING',
  concluded: false,
});

const sess = (id: string, attendanceId: string, start: Date, statusLabel = 'Confirmado'): ClinicalSession => ({
  id,
  attendanceId,
  disciplineId: 'd1',
  disciplineName: 'Clínica Integrada I',
  firstName: 'Zuleica',
  professorName: 'Prof. X',
  locationName: 'Ambulatório 1',
  startAt: start,
  endAt: new Date(start.getTime() + 60 * 60_000),
  rescheduledStartAt: null,
  statusLabel,
});

/** SIASB falso programável: registra cada chamada; as escritas guardam o corpo recebido. */
class FakeSiasb extends SiasbSource {
  calls: string[] = [];
  active: ClinicalAttendance[] = [att('100'), att('200', 'd2')];
  list: ClinicalSession[] = [];
  catalog: Procedure[] = [
    { id: '7', name: 'Restauração' },
    { id: '8', name: 'Profilaxia' },
  ];
  options: SchedulingOptions = {
    professors: [{ id: '11', name: 'Profa. Ana', preferred: true }],
    locations: [{ id: '21', name: 'Clínica 3', preferred: false }],
    groups: [{ id: '31', name: 'Adulto', preferred: false }],
  };
  writeFailure: SiasbError | null = null;
  readFailureAfterWrite: SiasbError | null = null;
  readFailureBeforeWrite: SiasbError | null = null;
  created: string | null = '555';
  /** Sessões que passam a existir depois do agendamento (o que o SIASB gravou). */
  afterSchedule: ClinicalSession[] = [];
  scheduleBodies: ScheduleSessionsInput[] = [];
  unscheduleBodies: { sessionId: string; reason: string }[] = [];
  addBodies: { attendanceId: string; serviceId: number; teeth: string; faces: string; observation: string }[] = [];
  removeBodies: { attendanceId: string; procedureId: string }[] = [];
  sessionRanges: { from: Date; to: Date }[] = [];
  private wrote = false;

  async courseOptions(): Promise<never> {
    throw new Error('no');
  }
  async login(): Promise<never> {
    throw new Error('no');
  }
  async disciplines() {
    this.calls.push('disciplines');
    return [];
  }
  async attendances(_s: SiasbSession, which: 'active' | 'inactive') {
    this.calls.push(`attendances:${which}`);
    return which === 'active' ? this.active : [];
  }
  async sessions(_s: SiasbSession, from: Date, to: Date) {
    this.calls.push('sessions');
    this.sessionRanges.push({ from, to });
    if (this.wrote && this.readFailureAfterWrite) throw this.readFailureAfterWrite;
    if (!this.wrote && this.readFailureBeforeWrite) throw this.readFailureBeforeWrite;
    return this.list;
  }
  async procedures(_s: SiasbSession, attendanceId: string) {
    this.calls.push(`procedures:${attendanceId}`);
    return this.catalog;
  }
  async unassignedCount() {
    return {};
  }
  async schedulingOptions(_s: SiasbSession, attendanceId: string) {
    this.calls.push(`options:${attendanceId}`);
    return this.options;
  }
  private async write(name: string): Promise<WriteResult> {
    this.calls.push(name);
    if (this.writeFailure) throw this.writeFailure;
    this.wrote = true;
    return { ok: true, createdId: this.created };
  }
  async scheduleSessions(_s: SiasbSession, input: ScheduleSessionsInput) {
    this.scheduleBodies.push(input);
    const r = await this.write('scheduleSessions');
    this.list = [...this.list, ...this.afterSchedule];
    return r;
  }
  async unscheduleSession(_s: SiasbSession, sessionId: string, reason: string) {
    this.unscheduleBodies.push({ sessionId, reason });
    const r = await this.write('unscheduleSession');
    this.list = this.list.map((s) => (s.id === sessionId ? { ...s, statusLabel: 'Desmarcado' } : s));
    return r;
  }
  async addProcedure(
    _s: SiasbSession,
    attendanceId: string,
    i: { serviceId: number; teeth: string; faces: string; observation: string },
  ) {
    this.addBodies.push({ attendanceId, ...i });
    return this.write('addProcedure');
  }
  async removeProcedure(_s: SiasbSession, attendanceId: string, procedureId: string) {
    this.removeBodies.push({ attendanceId, procedureId });
    return this.write('removeProcedure');
  }
}

const WRITES = ['scheduleSessions', 'unscheduleSession', 'addProcedure', 'removeProcedure'];

function setup() {
  const siasb = new FakeSiasb();
  const accounts = new FakeAccounts();
  const runner = new SiasbSessionRunner(accounts, new FakeCipher());
  const audit = new InMemorySiasbWriteAudit();
  const syncCalls: string[] = [];
  let syncResult: SyncOutcome | Error = 'OK';
  const syncer = {
    syncUser: async (userId: string): Promise<SyncOutcome> => {
      syncCalls.push(userId);
      if (syncResult instanceof Error) throw syncResult;
      return syncResult;
    },
  };
  const markDue: string[] = [];
  const copy = { markDue: async (userId: string) => void markDue.push(userId) };
  const writer = new SiasbWriter(runner, siasb, syncer, copy, audit, () => NOW);
  return {
    siasb,
    accounts,
    audit,
    writer,
    syncCalls,
    markDue,
    setSync: (r: SyncOutcome | Error) => (syncResult = r),
    writes: () => siasb.calls.filter((c) => WRITES.includes(c)),
  };
}

const scheduleInput = (over: Partial<Parameters<SiasbWriter['scheduleSession']>[1]> = {}) => ({
  attendanceId: '100',
  start: START,
  durationMin: 120,
  professorId: '11',
  localId: '21',
  grupoId: '31',
  count: 3,
  confirmed: false,
  ...over,
});

const expectedStarts = (n: number) => Array.from({ length: n }, (_, k) => new Date(START.getTime() + k * WEEK));

describe('SiasbWriter.scheduleSession', () => {
  it('sem confirmed: só lê, não escreve e devolve o resumo exato', async () => {
    const t = setup();
    const out = await t.writer.scheduleSession('u1', scheduleInput());
    expect(t.writes()).toEqual([]);
    expect(out).toEqual({
      status: 'preview',
      summary:
        'Vai agendar 3 sessões semanais, uma por semana, no mesmo horário; é tudo ou nada. A primeira é sexta, ' +
        '20/11/2026, às 10h (horário da Bahia), com 120 minutos cada. Professor: Profa. Ana. Local: Clínica 3. ' +
        'Grupo: Adulto.',
      details: {
        atendimentoId: '100',
        quantidade: 3,
        duracaoMin: 120,
        datas: expectedStarts(3).map(bahiaIso),
        professor: 'Profa. Ana',
        local: 'Clínica 3',
        grupo: 'Adulto',
      },
    });
    expect(t.audit.rows).toEqual([]);
    expect(t.syncCalls).toEqual([]);
  });

  it('confirmed diferente de true (ex.: "true") não escreve', async () => {
    const t = setup();
    const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: 'true' as unknown as boolean }));
    expect(out.status).toBe('preview');
    expect(t.writes()).toEqual([]);
  });

  it('uma sessão: resumo no singular', async () => {
    const t = setup();
    const out = await t.writer.scheduleSession('u1', scheduleInput({ count: 1, observacao: PACIENTE }));
    expect(out.status === 'preview' && out.summary).toBe(
      'Vai agendar 1 sessão: sexta, 20/11/2026, às 10h (horário da Bahia), com 120 minutos. Professor: Profa. Ana. ' +
        'Local: Clínica 3. Grupo: Adulto. Vai com a observação informada.',
    );
  });

  it('atendimento fora dos ativos: WriteInputError e nenhuma escrita', async () => {
    const t = setup();
    await expect(t.writer.scheduleSession('u1', scheduleInput({ attendanceId: '999', confirmed: true }))).rejects.toBeInstanceOf(
      WriteInputError,
    );
    expect(t.writes()).toEqual([]);
    expect(t.siasb.calls).not.toContain('options:999');
  });

  it.each([
    ['professorId', 'professor'],
    ['localId', 'local'],
    ['grupoId', 'grupo'],
  ] as const)('faltando %s: choose com as opções e sem escrita, mesmo com confirmed', async (field, missing) => {
    const t = setup();
    const out = await t.writer.scheduleSession('u1', scheduleInput({ [field]: undefined, confirmed: true }));
    expect(out).toEqual({ status: 'choose', options: t.siasb.options, missing: [missing] });
    expect(t.writes()).toEqual([]);
    expect(t.audit.rows).toEqual([]);
  });

  it('faltando todos: missing na ordem professor, local, grupo', async () => {
    const t = setup();
    const out = await t.writer.scheduleSession(
      'u1',
      scheduleInput({ professorId: undefined, localId: undefined, grupoId: undefined }),
    );
    expect(out.status === 'choose' && out.missing).toEqual(['professor', 'local', 'grupo']);
  });

  it.each([['professorId'], ['localId'], ['grupoId']] as const)('%s inexistente nas opções: recusa sem escrita', async (field) => {
    const t = setup();
    await expect(t.writer.scheduleSession('u1', scheduleInput({ [field]: '77', confirmed: true }))).rejects.toBeInstanceOf(
      WriteInputError,
    );
    expect(t.writes()).toEqual([]);
  });

  it.each([
    ['quantidade 0', { count: 0 }],
    ['quantidade 21', { count: 21 }],
    ['quantidade fracionária', { count: 2.5 }],
    ['duração 14', { durationMin: 14 }],
    ['duração 241', { durationMin: 241 }],
    ['início no passado', { start: new Date('2026-11-16T11:59:00Z') }],
    ['início além de 365 dias', { start: new Date(NOW.getTime() + 366 * 86_400_000) }],
    ['data inválida', { start: new Date('x') }],
    ['observação longa', { observacao: 'a'.repeat(301) }],
    ['atendimento não numérico', { attendanceId: '10a' }],
  ])('%s: WriteInputError sem eco e sem tocar o SIASB', async (_n, over) => {
    const t = setup();
    const err = await t.writer.scheduleSession('u1', scheduleInput({ ...over, confirmed: true })).catch((e) => e);
    expect(err).toBeInstanceOf(WriteInputError);
    expect(err.code).toBe('entrada_invalida');
    for (const v of Object.values(over)) {
      const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString()) : String(v);
      if (s.length > 1) expect(err.message).not.toContain(s);
    }
    expect(t.siasb.calls).toEqual([]);
  });

  it('confirmed: escreve uma vez com ids e datas, relê, verifica, audita ok e ressincroniza', async () => {
    const t = setup();
    t.siasb.afterSchedule = expectedStarts(3).map((d, k) => sess(`n${k}`, '100', d, 'Nova'));
    const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true, observacao: 'obs' }));
    expect(t.writes()).toEqual(['scheduleSessions']);
    expect(t.siasb.scheduleBodies).toEqual([
      {
        attendanceId: '100',
        professorId: '11',
        locationId: '21',
        groupId: '31',
        startAt: START,
        endAt: new Date(START.getTime() + 120 * 60_000),
        count: 3,
        description: 'obs',
      },
    ]);
    // relê do início até o fim da última sessão
    const reread = t.siasb.sessionRanges.at(-1)!;
    expect(reread.from.getTime()).toBeLessThanOrEqual(START.getTime());
    expect(reread.to.getTime()).toBeGreaterThanOrEqual(START.getTime() + 2 * WEEK + 120 * 60_000);
    expect(out.status).toBe('done');
    expect(out.status === 'done' && out.details.verificado).toBe(true);
    expect(out.status === 'done' && out.details.datasConfirmadas).toEqual(expectedStarts(3).map(bahiaIso));
    expect(JSON.stringify(out)).not.toContain('Zuleica');
    expect(t.audit.rows).toEqual([{ userId: 'u1', kind: 'schedule', attendanceId: '100', targetId: undefined, result: 'ok', at: NOW }]);
    expect(t.syncCalls).toEqual(['u1']);
    expect(t.markDue).toEqual([]);
  });

  it('início com segundos e frações: normalizado para o minuto inteiro antes de enviar e conferir', async () => {
    const t = setup();
    t.siasb.afterSchedule = [sess('n0', '100', START, 'Nova')];
    const out = await t.writer.scheduleSession(
      'u1',
      scheduleInput({ start: new Date(START.getTime() + 42_500), count: 1, confirmed: true }),
    );
    expect(t.siasb.scheduleBodies[0].startAt).toEqual(START);
    expect(t.siasb.scheduleBodies[0].endAt).toEqual(new Date(START.getTime() + 120 * 60_000));
    expect(out.status === 'done' && out.details.verificado).toBe(true);
    expect(out.status === 'done' && out.details.datas).toEqual(['2026-11-20T10:00:00-03:00']);
  });

  it('sem observação: description vazia', async () => {
    const t = setup();
    await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }));
    expect(t.siasb.scheduleBodies[0].description).toBe('');
  });

  it('aceito mas não confirmado na releitura: verificado false, não é erro', async () => {
    const t = setup();
    t.siasb.afterSchedule = [sess('n0', '100', START, 'Nova')];
    const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }));
    expect(out.status).toBe('done');
    expect(out.status === 'done' && out.details.verificado).toBe(false);
    expect(out.status === 'done' && out.details.datasConfirmadas).toEqual([bahiaIso(START)]);
    expect(out.status === 'done' && out.summary).toContain('não deu para confirmar');
  });

  it('releitura que falha depois da escrita: continua sucesso, verificado false', async () => {
    const t = setup();
    t.siasb.readFailureAfterWrite = new SiasbError('UNAVAILABLE');
    const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }));
    expect(out.status === 'done' && out.details.verificado).toBe(false);
    expect(t.audit.rows.map((r) => r.result)).toEqual(['ok']);
  });

  describe('conferência só por sessões novas', () => {
    const one = (over = {}) => scheduleInput({ count: 1, confirmed: true, ...over });

    it('sessão desmarcada que já existia no mesmo início não conta', async () => {
      const t = setup();
      t.siasb.list = [sess('old', '100', START, 'Desmarcado')];
      const out = await t.writer.scheduleSession('u1', one());
      expect(t.writes()).toEqual(['scheduleSessions']);
      expect(out.status === 'done' && out.details.verificado).toBe(false);
      expect(out.status === 'done' && out.details.datasConfirmadas).toEqual([]);
    });

    it('sessão marcada que já existia no mesmo início não conta', async () => {
      const t = setup();
      t.siasb.list = [sess('old', '100', START, 'Confirmado')];
      const out = await t.writer.scheduleSession('u1', one());
      expect(out.status === 'done' && out.details.verificado).toBe(false);
    });

    it('sessão nova e marcada conta, mesmo com uma antiga desmarcada no mesmo início', async () => {
      const t = setup();
      t.siasb.list = [sess('old', '100', START, 'Desmarcado')];
      t.siasb.afterSchedule = [sess('n0', '100', START, 'Nova')];
      const out = await t.writer.scheduleSession('u1', one());
      expect(out.status === 'done' && out.details.verificado).toBe(true);
      expect(out.status === 'done' && out.details.datasConfirmadas).toEqual([bahiaIso(START)]);
      // a leitura prévia é da mesma janela da conferência
      expect(t.siasb.sessionRanges).toHaveLength(2);
      expect(t.siasb.sessionRanges[0]).toEqual(t.siasb.sessionRanges[1]);
    });

    it('sessão nova mas não marcada não conta', async () => {
      const t = setup();
      t.siasb.afterSchedule = [sess('n0', '100', START, 'Desmarcado')];
      const out = await t.writer.scheduleSession('u1', one());
      expect(out.status === 'done' && out.details.verificado).toBe(false);
    });

    it('leitura prévia que falha: escreve assim mesmo e verificado false', async () => {
      const t = setup();
      t.siasb.readFailureBeforeWrite = new SiasbError('UNAVAILABLE');
      t.siasb.afterSchedule = [sess('n0', '100', START, 'Nova')];
      const out = await t.writer.scheduleSession('u1', one());
      expect(t.writes()).toEqual(['scheduleSessions']);
      expect(out.status === 'done' && out.details.verificado).toBe(false);
    });

    it('leitura prévia com sessão expirada: ReconectarError e nenhuma escrita', async () => {
      const t = setup();
      t.siasb.readFailureBeforeWrite = new SiasbError('REAUTH_NEEDED');
      await expect(t.writer.scheduleSession('u1', one())).rejects.toBeInstanceOf(ReconectarError);
      expect(t.writes()).toEqual([]);
    });
  });

  it('série cuja última sessão passa de 365 dias: WriteInputError sem tocar o SIASB', async () => {
    const t = setup();
    const start = new Date(NOW.getTime() + 300 * 86_400_000);
    const err = await t.writer.scheduleSession('u1', scheduleInput({ start, count: 20, confirmed: true })).catch((e) => e);
    expect(err).toBeInstanceOf(WriteInputError);
    expect(t.siasb.calls).toEqual([]);
  });

  it('última sessão exatamente em 365 dias: aceita', async () => {
    const t = setup();
    const start = new Date(NOW.getTime() + 358 * 86_400_000);
    const out = await t.writer.scheduleSession('u1', scheduleInput({ start, count: 2 }));
    expect(out.status).toBe('preview');
  });

  it('WRITE_UNKNOWN: siasb_write_unknown, uma tentativa só, auditoria unknown, markDue', async () => {
    const t = setup();
    t.siasb.writeFailure = new SiasbError('WRITE_UNKNOWN', 'O SIASB não confirmou a operação.');
    t.setSync('BUSY');
    const err = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true })).catch((e) => e);
    expect(err).toBeInstanceOf(WriteFailedError);
    expect(err.code).toBe('siasb_write_unknown');
    expect(err.message).toBe('O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo.');
    expect(t.writes()).toEqual(['scheduleSessions']);
    expect(t.audit.rows.map((r) => r.result)).toEqual(['unknown']);
    expect(t.markDue).toEqual(['u1']);
  });

  it('recusa da grade: a mensagem da grade', async () => {
    const t = setup();
    const grade = 'Você não possui aula desta disciplina neste dia e horário.';
    t.siasb.writeFailure = new SiasbError('WRITE_REJECTED', grade);
    const err = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true })).catch((e) => e);
    expect(err).toBeInstanceOf(WriteFailedError);
    expect(err.code).toBe('siasb_write_rejected');
    expect(err.message).toBe(grade);
    expect(t.audit.rows.map((r) => r.result)).toEqual(['rejected']);
    expect(t.syncCalls).toEqual([]);
  });

  it('recusa genérica: mensagem fixa', async () => {
    const t = setup();
    t.siasb.writeFailure = new SiasbError('WRITE_REJECTED', 'O SIASB recusou a operação.');
    const err = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true })).catch((e) => e);
    expect(err.code).toBe('siasb_write_rejected');
    expect(err.message).toBe('O SIASB recusou a operação.');
  });

  it('REAUTH_NEEDED: ReconectarError passa adiante', async () => {
    const t = setup();
    t.siasb.writeFailure = new SiasbError('REAUTH_NEEDED');
    await expect(t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }))).rejects.toBeInstanceOf(ReconectarError);
  });

  it('erro de leitura antes da escrita: mapeamento padrão (SiasbReadError)', async () => {
    const t = setup();
    t.siasb.attendances = async () => {
      throw new SiasbError('UNAVAILABLE');
    };
    await expect(t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }))).rejects.toBeInstanceOf(SiasbReadError);
    expect(t.writes()).toEqual([]);
  });

  it.each([['BUSY'], ['UNAVAILABLE'], [new Error('db fora')]] as const)(
    'ressincronização %s: markDue e a escrita continua sucesso',
    async (r) => {
      const t = setup();
      t.setSync(r as SyncOutcome | Error);
      const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }));
      expect(out.status).toBe('done');
      expect(t.markDue).toEqual(['u1']);
    },
  );

  it('auditoria que falha não vira erro', async () => {
    const t = setup();
    t.audit.record = async () => {
      throw new Error('db fora');
    };
    const out = await t.writer.scheduleSession('u1', scheduleInput({ confirmed: true }));
    expect(out.status).toBe('done');
  });
});

describe('SiasbWriter.unscheduleSession', () => {
  const future = new Date('2026-11-27T13:00:00Z');

  it('sem confirmed: resumo com data e disciplina, sem escrita', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '100', future)];
    const out = await t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: false });
    expect(out).toEqual({
      status: 'preview',
      summary:
        'Vai desmarcar a sessão de Clínica Integrada I de sexta, 27/11/2026, às 10h (horário da Bahia), com o motivo ' +
        '"Desmarcado pelo aluno". Não registra falta.',
      details: { sessaoId: '500', atendimentoId: '100', disciplina: 'Clínica Integrada I', inicio: bahiaIso(future) },
    });
    expect(t.writes()).toEqual([]);
    const range = t.siasb.sessionRanges[0];
    expect(range.from).toEqual(new Date(NOW.getTime() - 14 * 86_400_000));
    expect(range.to).toEqual(new Date(NOW.getTime() + 45 * 86_400_000));
  });

  it('motivo informado não é ecoado no resumo', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '100', future)];
    const out = await t.writer.unscheduleSession('u1', { sessionId: '500', motivo: PACIENTE, confirmed: false });
    expect(out.status === 'preview' && out.summary).toContain('com o motivo informado');
    expect(JSON.stringify(out)).not.toContain(PACIENTE);
  });

  it.each([
    ['sessão passada', { startAt: new Date(NOW.getTime() - 86_400_000) }],
    ['sessão começando agora', { startAt: NOW }],
    ['reagendada para o passado', { rescheduledStartAt: new Date(NOW.getTime() - 3_600_000) }],
  ])('%s: WriteInputError e nenhuma escrita', async (_n, over) => {
    const t = setup();
    t.siasb.list = [{ ...sess('500', '100', future), ...over }];
    const err = await t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteInputError);
    expect(err.message).toBe('Só é possível desmarcar sessões futuras; para sessão passada use o site do SIASB.');
    expect(t.writes()).toEqual([]);
  });

  it('reagendada para o futuro: aceita', async () => {
    const t = setup();
    t.siasb.list = [{ ...sess('500', '100', future), rescheduledStartAt: new Date(future.getTime() + 86_400_000) }];
    const out = await t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: false });
    expect(out.status).toBe('preview');
  });

  it('sessão alheia (não está na lista da pessoa): recusa sem escrita', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '100', future)];
    await expect(t.writer.unscheduleSession('u1', { sessionId: '501', confirmed: true })).rejects.toBeInstanceOf(
      WriteInputError,
    );
    expect(t.writes()).toEqual([]);
  });

  it('sessão já desmarcada: recusa sem escrita', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '100', future, 'Desmarcado')];
    await expect(t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: true })).rejects.toBeInstanceOf(
      WriteInputError,
    );
    expect(t.writes()).toEqual([]);
  });

  it('sessão de atendimento não ativo: recusa sem escrita', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '300', future)];
    await expect(t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: true })).rejects.toBeInstanceOf(
      WriteInputError,
    );
    expect(t.writes()).toEqual([]);
  });

  // `absence: false` é fixo no cliente (o writer nem passa esse campo): ver siasb-client.spec.ts.
  it('confirmed: desmarca com o motivo padrão, verifica e audita', async () => {
    const t = setup();
    t.siasb.list = [sess('500', '100', future)];
    const out = await t.writer.unscheduleSession('u1', { sessionId: '500', confirmed: true });
    expect(t.siasb.unscheduleBodies).toEqual([{ sessionId: '500', reason: 'Desmarcado pelo aluno' }]);
    expect(out.status === 'done' && out.details.verificado).toBe(true);
    expect(t.audit.rows).toEqual([
      { userId: 'u1', kind: 'unschedule', attendanceId: '100', targetId: '500', result: 'ok', at: NOW },
    ]);
    expect(t.syncCalls).toEqual(['u1']);
  });

  it('id de sessão não numérico ou motivo longo: WriteInputError sem tocar o SIASB', async () => {
    const t = setup();
    await expect(t.writer.unscheduleSession('u1', { sessionId: '5/../x', confirmed: true })).rejects.toBeInstanceOf(
      WriteInputError,
    );
    await expect(
      t.writer.unscheduleSession('u1', { sessionId: '500', motivo: 'a'.repeat(301), confirmed: true }),
    ).rejects.toBeInstanceOf(WriteInputError);
    expect(t.siasb.calls).toEqual([]);
  });
});

describe('SiasbWriter.addProcedure', () => {
  it('sem confirmed: resumo com código, nome, dente, face e PREVISTO, sem escrita', async () => {
    const t = setup();
    const out = await t.writer.addProcedure('u1', {
      attendanceId: '100',
      serviceId: '7',
      teeth: '11',
      faces: 'V',
      confirmed: false,
    });
    expect(out).toEqual({
      status: 'preview',
      summary:
        'Vai incluir o procedimento 7 (Restauração) no atendimento 100, dente 11, face V. Ficará como PREVISTO; ' +
        'para realizar, use o site.',
      details: { atendimentoId: '100', servicoId: '7', procedimento: 'Restauração', dente: '11', face: 'V' },
    });
    expect(t.writes()).toEqual([]);
  });

  it('serviço fora do catálogo do atendimento: recusa sem escrita', async () => {
    const t = setup();
    await expect(
      t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '9', confirmed: true }),
    ).rejects.toBeInstanceOf(WriteInputError);
    expect(t.writes()).toEqual([]);
  });

  it('atendimento fora dos ativos: recusa sem escrita', async () => {
    const t = setup();
    await expect(
      t.writer.addProcedure('u1', { attendanceId: '999', serviceId: '7', confirmed: true }),
    ).rejects.toBeInstanceOf(WriteInputError);
    expect(t.writes()).toEqual([]);
  });

  it('confirmed: inclui e devolve procedimentoId', async () => {
    const t = setup();
    const out = await t.writer.addProcedure('u1', {
      attendanceId: '100',
      serviceId: '7',
      observacao: 'obs',
      confirmed: true,
    });
    expect(t.siasb.addBodies).toEqual([
      { attendanceId: '100', serviceId: 7, teeth: '', faces: '', observation: 'obs' },
    ]);
    expect(out.status === 'done' && out.details.procedimentoId).toBe('555');
    expect(t.audit.rows).toEqual([
      { userId: 'u1', kind: 'procedure_add', attendanceId: '100', targetId: '555', result: 'ok', at: NOW },
    ]);
  });

  it('confirmed sem createdId: procedimentoId null e aviso', async () => {
    const t = setup();
    t.siasb.created = null;
    const out = await t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '7', confirmed: true });
    expect(out.status === 'done' && out.details.procedimentoId).toBeNull();
    expect(out.status === 'done' && out.summary).toContain('exclua pelo site');
  });

  it('createdId com mais de 12 dígitos: procedimentoId null e aviso (a rota de excluir só aceita até 12)', async () => {
    const t = setup();
    t.siasb.created = '1234567890123';
    const out = await t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '7', confirmed: true });
    expect(out.status === 'done' && out.details.procedimentoId).toBeNull();
    expect(out.status === 'done' && out.summary).toContain('exclua pelo site');
  });

  it('dente, face ou observação inválidos: WriteInputError sem tocar o SIASB', async () => {
    const t = setup();
    for (const over of [{ teeth: 'x'.repeat(51) }, { faces: 'a\nb' }, { observacao: 'a'.repeat(301) }, { serviceId: 'abc' }]) {
      await expect(
        t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '7', confirmed: true, ...over }),
      ).rejects.toBeInstanceOf(WriteInputError);
    }
    expect(t.siasb.calls).toEqual([]);
  });
});

describe('SiasbWriter.removeProcedure', () => {
  const seed = (t: ReturnType<typeof setup>, over: Partial<{ userId: string; attendanceId: string; targetId: string; result: 'ok' | 'unknown' }> = {}) =>
    t.audit.record({ userId: 'u1', kind: 'procedure_add', attendanceId: '100', targetId: '42', result: 'ok', at: NOW, ...over });
  const GUARD = 'Só é possível excluir por aqui um procedimento incluído por esta ferramenta; para os demais use o site do SIASB.';

  it('sem confirmed: resumo e nenhuma escrita', async () => {
    const t = setup();
    await seed(t);
    const out = await t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '42', confirmed: false });
    expect(out).toEqual({
      status: 'preview',
      summary: 'Vai pedir ao SIASB para excluir o procedimento de id 42 do atendimento 100.',
      details: { atendimentoId: '100', procedimentoId: '42' },
    });
    expect(t.writes()).toEqual([]);
  });

  it('confirmed: só então chama removeProcedure', async () => {
    const t = setup();
    await seed(t);
    const out = await t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '42', confirmed: true });
    expect(t.siasb.removeBodies).toEqual([{ attendanceId: '100', procedureId: '42' }]);
    expect(out.status).toBe('done');
    expect(t.audit.rows.slice(1).map((r) => [r.kind, r.targetId, r.result])).toEqual([['procedure_remove', '42', 'ok']]);
  });

  it.each([
    ['sem inclusão registrada', null],
    ['inclusão de outra pessoa', { userId: 'u2' }],
    ['inclusão em outro atendimento', { attendanceId: '200' }],
    ['inclusão de outro id', { targetId: '43' }],
    ['inclusão sem confirmação (unknown)', { result: 'unknown' as const }],
  ])('%s: WriteInputError e nenhuma escrita (também sem confirmed)', async (_n, over) => {
    const t = setup();
    if (over) await seed(t, over);
    for (const confirmed of [false, true]) {
      const err = await t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '42', confirmed }).catch((e) => e);
      expect(err).toBeInstanceOf(WriteInputError);
      expect(err.message).toBe(GUARD);
    }
    expect(t.writes()).toEqual([]);
  });

  it('incluir e depois excluir o id devolvido pela inclusão', async () => {
    const t = setup();
    t.siasb.created = '42';
    await t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '7', confirmed: true });
    const out = await t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '42', confirmed: true });
    expect(out.status).toBe('done');
    expect(t.writes()).toEqual(['addProcedure', 'removeProcedure']);
  });

  it('falha ao consultar a auditoria: recusa (porta fechada) sem escrita', async () => {
    const t = setup();
    t.audit.hasProcedureAdd = async () => {
      throw new Error('db fora');
    };
    await expect(
      t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '42', confirmed: true }),
    ).rejects.toThrow(GUARD);
    expect(t.writes()).toEqual([]);
  });

  it('procedureId não numérico ou atendimento alheio: recusa sem escrita', async () => {
    const t = setup();
    await expect(
      t.writer.removeProcedure('u1', { attendanceId: '100', procedureId: '4a', confirmed: true }),
    ).rejects.toBeInstanceOf(WriteInputError);
    await expect(
      t.writer.removeProcedure('u1', { attendanceId: '999', procedureId: '42', confirmed: true }),
    ).rejects.toBeInstanceOf(WriteInputError);
    expect(t.writes()).toEqual([]);
  });
});

describe('SiasbWriter: canário de dado de paciente', () => {
  it('observação e motivo com nome de paciente nunca aparecem em saída, erro ou auditoria', async () => {
    const t = setup();
    const out: string[] = [];
    const spies = [
      jest.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true)),
      jest.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true)),
      ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' '))),
      ),
      ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' '))),
      ),
    ];
    try {
      t.siasb.list = [sess('500', '100', new Date('2026-11-27T13:00:00Z'))];
      const results: unknown[] = [];
      results.push(await t.writer.scheduleSession('u1', scheduleInput({ observacao: PACIENTE })));
      results.push(await t.writer.scheduleSession('u1', scheduleInput({ observacao: PACIENTE, confirmed: true })));
      results.push(await t.writer.unscheduleSession('u1', { sessionId: '500', motivo: PACIENTE, confirmed: false }));
      results.push(await t.writer.unscheduleSession('u1', { sessionId: '500', motivo: PACIENTE, confirmed: true }));
      results.push(
        await t.writer.addProcedure('u1', { attendanceId: '100', serviceId: '7', observacao: PACIENTE, confirmed: true }),
      );
      t.siasb.writeFailure = new SiasbError('WRITE_UNKNOWN');
      results.push(
        await t.writer
          .addProcedure('u1', { attendanceId: '100', serviceId: '7', observacao: PACIENTE, confirmed: true })
          .catch((e: Error) => ({ name: e.name, message: e.message, code: (e as { code?: string }).code })),
      );
      results.push(
        await t.writer
          .scheduleSession('u1', scheduleInput({ observacao: PACIENTE + 'x'.repeat(300), confirmed: true }))
          .catch((e: Error) => ({ message: e.message })),
      );
      const all = [...out, JSON.stringify(results), JSON.stringify(t.audit.rows)].join('\n');
      expect(all).not.toContain('Zuleica');
      expect(all).not.toContain('Canario');
      // a observação foi de fato ao SIASB (só lá)
      expect(t.siasb.scheduleBodies[0].description).toBe(PACIENTE);
      expect(t.siasb.unscheduleBodies[0].reason).toBe(PACIENTE);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
