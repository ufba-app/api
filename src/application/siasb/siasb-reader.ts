import { computeStates, isMarked, type ClinicalState } from '../../domain/siasb/clinical-state';
import { deduceSlots, nextSlotStart } from '../../domain/siasb/clinic-slots';
import { estimateBookingDeadline } from '../../domain/siasb/deadline';
import type { ClinicalAttendance, ClinicalSession, Procedure } from '../../domain/siasb/types';
import type { AcademicCalendar } from '../ports/academic-calendar';
import type { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, type SiasbSession, type SiasbSource } from '../ports/siasb-source';
import { decodeSession, encodeSession } from './session-codec';
import { computeProgress, PROGRESS_DEFAULT_DAYS, type Progress } from './progress';
import {
  DAY_MS,
  InvalidPeriodError,
  MAX_AHEAD_DAYS,
  MAX_CALL_DAYS,
  resolveSessionPeriod,
  SYNC_LOOKBACK_DAYS,
} from './session-period';

const HISTORY_DAYS = 60;

export { InvalidPeriodError };

export interface DisciplineSituation {
  disciplineId: string;
  disciplineName: string;
  state: ClinicalState;
  nextSlot: Date | null;
  deadline: Date | null;
  estimated: true;
  holidaysConsidered: boolean;
}

export interface BookingDeadline {
  deadline: Date;
  estimated: true;
  holidaysConsidered: boolean;
}

const PROCEDURES_LIMIT = 50;
const SLOTS_SHOWN = 3;

export interface PatientsByDiscipline {
  disciplineId: string;
  disciplineName: string;
  patients: { attendanceId: string; firstName: string; type: ClinicalAttendance['treatmentType'] }[];
}

export interface SchedulingContext {
  attendanceId: string;
  disciplineName: string | null;
  sessionDurationMin: number | null;
  attendanceSessions: number;
  procedures: Procedure[];
  totalProcedures: number;
  moreProcedures: boolean;
  nextSlots: { start: Date; deadline: Date }[];
  holidaysConsidered: boolean;
}

/** A pessoa precisa entrar de novo no painel (sem conta SIASB, conta marcada ou 401 no meio da leitura). */
export class ReconectarError extends Error {
  readonly code = 'reconectar' as const;
  constructor() {
    super('Sua conexão com o SIASB expirou. Entre de novo no painel.');
    this.name = 'ReconectarError';
  }
}

const MESSAGES = {
  siasb_unavailable: 'O SIASB não respondeu agora. Tente de novo em instantes.',
  siasb_unexpected_format: 'O SIASB devolveu uma página que não conseguimos ler. Tente de novo mais tarde.',
  siasb_no_slot: 'Não achamos um horário de clínica conhecido para essa disciplina.',
  siasb_attendance_not_found:
    'Não achamos esse atendimento entre os seus atendimentos ativos. Confira o id em clinica_pacientes.',
} as const;

/** Falha de leitura sem relação com a sessão (SIASB fora do ar ou página diferente). Mensagem fixa, em pt-BR. */
export class SiasbReadError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'SiasbReadError';
  }
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function medianOf(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** Sessões que indicam horário fixo da clínica: marcadas ou já atendidas (cancelada/não agendada não conta). */
const countsForSlots = (s: ClinicalSession) => isMarked(s.statusLabel) || normalize(s.statusLabel) === 'atendido';

/**
 * Leitura clínica do SIASB com a sessão guardada da pessoa. Cada método abre o jar, consulta ao vivo e, se o SIASB
 * renovou cookie, grava o jar de volta (last-write-wins; a trava por pessoa vem com o agendador, na fase 2).
 */
export class SiasbReader {
  constructor(
    private readonly siasb: SiasbSource,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
    private readonly calendar: AcademicCalendar,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async situation(userId: string): Promise<DisciplineSituation[]> {
    const now = this.now();
    const { disciplines, attendances, sessions } = await this.withSession(userId, async (session) => {
      const disciplines = await this.siasb.disciplines(session);
      const attendances = await this.siasb.attendances(session, 'active');
      const sessions = await this.siasb.sessions(session, ...this.historyWindow(now));
      return { disciplines, attendances, sessions };
    });
    const states = computeStates({ disciplines, activeAttendances: attendances, sessions, now });
    const slots = deduceSlots(sessions.filter(countsForSlots));
    const holidays = await this.calendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS));
    return disciplines.map((disc) => {
      const state = states.find((s) => s.disciplineId === disc.id)?.state ?? 'NO_PATIENT';
      const nextSlot = this.nextUsableSlot(slots, disc.id, now, holidays);
      return {
        disciplineId: disc.id,
        disciplineName: disc.name,
        state,
        nextSlot,
        deadline: nextSlot ? this.deadlineFor(nextSlot, holidays) : null,
        estimated: true as const,
        holidaysConsidered: holidays.known,
      };
    });
  }

  async sessions(userId: string, range?: { from: Date; to: Date }): Promise<ClinicalSession[]> {
    const period = resolveSessionPeriod(this.now(), range);
    await this.requireAccount(userId);
    // Período inteiro além do alcance (agora+45 dias): não há o que perguntar ao SIASB.
    if (period.kind === 'empty') return [];
    return this.withSession(userId, (session) => this.siasb.sessions(session, period.from, period.to));
  }

  async bookingDeadline(
    userId: string,
    input: { disciplineId: string } | { sessionStart: Date },
  ): Promise<BookingDeadline> {
    const now = this.now();
    if ('sessionStart' in input) {
      // Literal: o prazo dessa sessão exata, mesmo que já tenha passado.
      await this.requireAccount(userId);
      const start = input.sessionStart;
      const holidays = await this.calendar.holidays(
        new Date(Math.min(now.getTime(), start.getTime())),
        new Date(Math.max(now.getTime(), start.getTime())),
      );
      return { deadline: this.deadlineFor(start, holidays), estimated: true, holidaysConsidered: holidays.known };
    }
    const sessions = await this.withSession(userId, (session) =>
      this.siasb.sessions(session, ...this.historyWindow(now)),
    );
    const slots = deduceSlots(sessions.filter(countsForSlots));
    const holidays = await this.calendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS));
    const next = this.nextUsableSlot(slots, input.disciplineId, now, holidays);
    if (!next) throw new SiasbReadError('siasb_no_slot');
    return { deadline: this.deadlineFor(next, holidays), estimated: true, holidaysConsidered: holidays.known };
  }

  async patients(userId: string): Promise<PatientsByDiscipline[]> {
    const { disciplines, attendances } = await this.withSession(userId, async (session) => ({
      disciplines: await this.siasb.disciplines(session),
      attendances: await this.siasb.attendances(session, 'active'),
    }));
    return disciplines.map((d) => ({
      disciplineId: d.id,
      disciplineName: d.name,
      patients: attendances
        .filter((a) => a.disciplineId === d.id)
        .map((a) => ({ attendanceId: a.id, firstName: a.firstName, type: a.treatmentType })),
    }));
  }

  /** Só contagens: a lista de pacientes sem responsável nunca sai do cliente. */
  async vacancies(userId: string): Promise<{ disciplineId: string; disciplineName: string; count: number }[]> {
    const { disciplines, counts } = await this.withSession(userId, async (session) => ({
      disciplines: await this.siasb.disciplines(session),
      counts: await this.siasb.unassignedCount(session),
    }));
    return disciplines.map((d) => ({ disciplineId: d.id, disciplineName: d.name, count: Number(counts[d.id]) || 0 }));
  }

  /**
   * Contexto para marcar sessões de um atendimento ATIVO da pessoa. O procedimento que o aluno cita não entra aqui:
   * `term` só filtra o catálogo (sem acento nem maiúsculas) e nada do que a pessoa disse vai ao SIASB.
   */
  async schedulingContext(userId: string, attendanceId: string, term?: string): Promise<SchedulingContext> {
    const now = this.now();
    const { attendance, disciplines, sessions, catalog } = await this.withSession(userId, async (session) => {
      const attendance = (await this.siasb.attendances(session, 'active')).find((a) => a.id === attendanceId);
      if (!attendance) throw new SiasbReadError('siasb_attendance_not_found');
      const disciplines = await this.siasb.disciplines(session);
      const sessions = await this.siasb.sessions(session, ...this.historyWindow(now));
      const catalog = await this.siasb.procedures(session, attendance.id);
      return { attendance, disciplines, sessions, catalog };
    });
    const slots = deduceSlots(sessions.filter(countsForSlots)).filter((s) => s.disciplineId === attendance.disciplineId);
    const holidays = await this.calendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS));
    const needle = term ? normalize(term) : '';
    const matching = needle ? catalog.filter((p) => normalize(p.name).includes(needle)) : catalog;
    return {
      attendanceId: attendance.id,
      disciplineName: disciplines.find((d) => d.id === attendance.disciplineId)?.name ?? null,
      sessionDurationMin: slots.length ? medianOf(slots.map((s) => s.durationMin)) : null,
      attendanceSessions: sessions.filter((s) => s.attendanceId === attendance.id && countsForSlots(s)).length,
      procedures: matching.slice(0, PROCEDURES_LIMIT),
      totalProcedures: matching.length,
      moreProcedures: matching.length > PROCEDURES_LIMIT,
      nextSlots: this.usableSlots(slots, attendance.disciplineId, now, holidays, SLOTS_SHOWN).map((start) => ({
        start,
        deadline: this.deadlineFor(start, holidays),
      })),
      holidaysConsidered: holidays.known,
    };
  }

  /** Uma só consulta de sessões, do início do período até o maior entre o fim e agora+45 dias (para as marcadas adiante). Sem `range`, os últimos `PROGRESS_DEFAULT_DAYS` até agora. Quem chama valida o período (tamanho e ordem). */
  async progress(userId: string, range?: { from: Date; to: Date }): Promise<Progress> {
    const now = this.now();
    const used = range ?? { from: new Date(now.getTime() - PROGRESS_DEFAULT_DAYS * DAY_MS), to: now };
    if (used.from.getTime() > used.to.getTime()) throw new InvalidPeriodError();
    // Estende até agora+45 só quando o fim do período está ao alcance dessa janela; a chamada nunca passa de 190 dias.
    const reach = now.getTime() + MAX_AHEAD_DAYS * DAY_MS;
    const extended = used.to.getTime() <= reach ? Math.max(used.to.getTime(), reach) : used.to.getTime();
    const forwardEnd = new Date(Math.min(extended, used.from.getTime() + MAX_CALL_DAYS * DAY_MS));
    const queryFrom = new Date(Math.max(used.from.getTime(), forwardEnd.getTime() - MAX_CALL_DAYS * DAY_MS));
    const { disciplines, active, inactive, sessions } = await this.withSession(userId, async (session) => ({
      disciplines: await this.siasb.disciplines(session),
      active: await this.siasb.attendances(session, 'active'),
      inactive: await this.siasb.attendances(session, 'inactive'),
      sessions: await this.siasb.sessions(session, queryFrom, forwardEnd),
    }));
    return computeProgress({ disciplines, active, inactive, sessions, range: used, isDefault: !range, now });
  }

  /**
   * Leitura para a cópia: atendimentos ativos e inativos, disciplinas e as sessões de [agora − 120 dias, agora + 45 dias]
   * (165 dias, abaixo do teto de 190: uma só chamada de sessões), tudo numa única sessão guardada.
   */
  async snapshot(userId: string): Promise<{
    window: { from: Date; to: Date };
    disciplines: { id: string; name: string }[];
    attendances: (ClinicalAttendance & { disciplineName: string })[];
    sessions: ClinicalSession[];
  }> {
    const now = this.now();
    const window = {
      from: new Date(now.getTime() - SYNC_LOOKBACK_DAYS * DAY_MS),
      to: new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS),
    };
    const { disciplines, active, inactive, sessions } = await this.withSession(userId, async (session) => ({
      disciplines: await this.siasb.disciplines(session),
      active: await this.siasb.attendances(session, 'active'),
      inactive: await this.siasb.attendances(session, 'inactive'),
      sessions: await this.siasb.sessions(session, window.from, window.to),
    }));
    const names = new Map(disciplines.map((d) => [d.id, d.name]));
    // A PK da cópia é (user_id, id): id repetido derrubaria a transação toda. Atendimento ativo vence o inativo
    // (vem primeiro); sessão repetida: a primeira.
    const firstById = <T extends { id: string }>(list: T[]): T[] => {
      const seen = new Set<string>();
      return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    };
    const attendances = firstById([...active, ...inactive]).map((a) => ({
      ...a,
      disciplineName: names.get(a.disciplineId) ?? '',
    }));
    return {
      window,
      disciplines: firstById(disciplines).map((d) => ({ id: d.id, name: d.name })),
      attendances,
      sessions: firstById(sessions),
    };
  }

  /** Próximo horário da disciplina cujo prazo estimado ainda não passou; senão, o da semana seguinte. */
  private nextUsableSlot(
    slots: ReturnType<typeof deduceSlots>,
    disciplineId: string,
    now: Date,
    holidays: { known: boolean; dates: string[] },
  ): Date | null {
    return this.usableSlots(slots, disciplineId, now, holidays, 1)[0] ?? null;
  }

  /** Até `max` próximos horários da disciplina com prazo estimado ainda por vir. */
  private usableSlots(
    slots: ReturnType<typeof deduceSlots>,
    disciplineId: string,
    now: Date,
    holidays: { known: boolean; dates: string[] },
    max: number,
  ): Date[] {
    const found: Date[] = [];
    let cursor = now;
    for (let i = 0; i < 5 + max && found.length < max; i++) {
      const slot = nextSlotStart(slots, disciplineId, cursor);
      if (!slot) break;
      if (this.deadlineFor(slot, holidays).getTime() > now.getTime()) found.push(slot);
      cursor = slot;
    }
    return found;
  }

  /** Sem calendário oficial, 1 dia útil de margem: o erro cai para o lado de chegar cedo. */
  private deadlineFor(start: Date, holidays: { known: boolean; dates: string[] }): Date {
    return estimateBookingDeadline(start, holidays.dates, holidays.known ? 0 : 1);
  }

  private historyWindow(now: Date): [Date, Date] {
    return [new Date(now.getTime() - HISTORY_DAYS * DAY_MS), new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS)];
  }

  private async requireAccount(userId: string): Promise<SourceAccountRecord> {
    const account = (await this.accounts.findByUserAndProvider(userId, 'SIASB'))[0];
    if (!account || account.status === 'REAUTH_NEEDED' || !account.secret) throw new ReconectarError();
    return account;
  }

  private async withSession<T>(userId: string, fn: (session: SiasbSession) => Promise<T>): Promise<T> {
    const account = await this.requireAccount(userId);
    let session: SiasbSession;
    try {
      session = decodeSession(this.cipher.decrypt(account.secret!), account.expiresAt);
    } catch {
      await this.accounts.setStatus(account.id, 'REAUTH_NEEDED');
      throw new ReconectarError();
    }
    let skipStore = false;
    try {
      return await fn(session);
    } catch (e) {
      if (e instanceof SiasbError) {
        if (e.code === 'REAUTH_NEEDED') {
          skipStore = true;
          await this.accounts.setStatus(account.id, 'REAUTH_NEEDED');
          throw new ReconectarError();
        }
        throw new SiasbReadError(e.code === 'UNEXPECTED_FORMAT' ? 'siasb_unexpected_format' : 'siasb_unavailable');
      }
      throw e;
    } finally {
      if (session.dirty && !skipStore) {
        // Melhor esforço: falha ao regravar (ex.: conta apagada no meio) nunca troca o resultado da leitura.
        try {
          await this.accounts.updateSecret(account.id, this.cipher.encrypt(encodeSession(session)), session.expiresAt ?? undefined);
        } catch {
          /* ignorado de propósito */
        }
      }
    }
  }
}
