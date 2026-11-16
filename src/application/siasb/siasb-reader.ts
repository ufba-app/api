import { deduceSlots } from '../../domain/siasb/clinic-slots';
import type { ClinicalAttendance, ClinicalSession, Procedure } from '../../domain/siasb/types';
import type { AcademicCalendar } from '../ports/academic-calendar';
import type { SourceAccountRepository } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import type { SiasbSession, SiasbSource } from '../ports/siasb-source';
import {
  computeSituation,
  countsForSlots,
  deadlineFor,
  historyWindow,
  nextUsableSlot,
  normalize,
  usableSlots,
  type DisciplineSituation,
} from './situation';
import { ReconectarError, SiasbReadError, SiasbSessionRunner } from './siasb-session-runner';
import { computeProgress, PROGRESS_DEFAULT_DAYS, type Progress } from './progress';
import {
  DAY_MS,
  InvalidPeriodError,
  MAX_AHEAD_DAYS,
  MAX_CALL_DAYS,
  resolveSessionPeriod,
  SYNC_LOOKBACK_DAYS,
} from './session-period';

export { InvalidPeriodError, ReconectarError, SiasbReadError };
export type { DisciplineSituation };

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

function medianOf(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/**
 * Leitura clínica do SIASB com a sessão guardada da pessoa. Cada método abre o jar, consulta ao vivo e, se o SIASB
 * renovou cookie, grava o jar de volta (last-write-wins; a trava por pessoa vem com o agendador, na fase 2).
 */
export class SiasbReader {
  private readonly runner: SiasbSessionRunner;

  constructor(
    private readonly siasb: SiasbSource,
    accounts: SourceAccountRepository,
    cipher: SecretCipher,
    private readonly calendar: AcademicCalendar,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runner = new SiasbSessionRunner(accounts, cipher);
  }

  async situation(userId: string): Promise<DisciplineSituation[]> {
    const now = this.now();
    const { disciplines, attendances, sessions } = await this.withSession(userId, async (session) => {
      const disciplines = await this.siasb.disciplines(session);
      const attendances = await this.siasb.attendances(session, 'active');
      const sessions = await this.siasb.sessions(session, ...historyWindow(now));
      return { disciplines, attendances, sessions };
    });
    const holidays = await this.calendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS));
    return computeSituation({ disciplines, activeAttendances: attendances, sessions, now, holidays });
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
      return { deadline: deadlineFor(start, holidays), estimated: true, holidaysConsidered: holidays.known };
    }
    const sessions = await this.withSession(userId, (session) =>
      this.siasb.sessions(session, ...historyWindow(now)),
    );
    const slots = deduceSlots(sessions.filter(countsForSlots));
    const holidays = await this.calendar.holidays(now, new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS));
    const next = nextUsableSlot(slots, input.disciplineId, now, holidays);
    if (!next) throw new SiasbReadError('siasb_no_slot');
    return { deadline: deadlineFor(next, holidays), estimated: true, holidaysConsidered: holidays.known };
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
      const sessions = await this.siasb.sessions(session, ...historyWindow(now));
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
      nextSlots: usableSlots(slots, attendance.disciplineId, now, holidays, SLOTS_SHOWN).map((start) => ({
        start,
        deadline: deadlineFor(start, holidays),
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
    attendances: (ClinicalAttendance & { disciplineName: string; active: boolean })[];
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
    const attendances = firstById([
      ...active.map((a) => ({ ...a, active: true })),
      ...inactive.map((a) => ({ ...a, active: false })),
    ]).map((a) => ({
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

  private requireAccount(userId: string) {
    return this.runner.requireAccount(userId);
  }

  private withSession<T>(userId: string, fn: (session: SiasbSession) => Promise<T>): Promise<T> {
    return this.runner.run(userId, fn);
  }
}
