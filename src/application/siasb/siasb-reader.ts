import { computeStates, isMarked, type ClinicalState } from '../../domain/siasb/clinical-state';
import { deduceSlots, nextSlotStart } from '../../domain/siasb/clinic-slots';
import { estimateBookingDeadline } from '../../domain/siasb/deadline';
import type { ClinicalSession } from '../../domain/siasb/types';
import type { AcademicCalendar } from '../ports/academic-calendar';
import type { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, type SiasbSession, type SiasbSource } from '../ports/siasb-source';
import { decodeSession, encodeSession } from './session-codec';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 14;
const MAX_AHEAD_DAYS = 45;
const HISTORY_DAYS = 60;

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
} as const;

/** Falha de leitura sem relação com a sessão (SIASB fora do ar ou página diferente). Mensagem fixa, em pt-BR. */
export class SiasbReadError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'SiasbReadError';
  }
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

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
    const now = this.now();
    const from = range?.from ?? now;
    const limit = new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS);
    const wanted = range?.to ?? new Date(from.getTime() + DEFAULT_RANGE_DAYS * DAY_MS);
    const to = wanted.getTime() > limit.getTime() ? limit : wanted;
    return this.withSession(userId, (session) => this.siasb.sessions(session, from, to));
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

  /** Próximo horário da disciplina cujo prazo estimado ainda não passou; senão, o da semana seguinte. */
  private nextUsableSlot(
    slots: ReturnType<typeof deduceSlots>,
    disciplineId: string,
    now: Date,
    holidays: { known: boolean; dates: string[] },
  ): Date | null {
    let cursor = now;
    for (let i = 0; i < 6; i++) {
      const slot = nextSlotStart(slots, disciplineId, cursor);
      if (!slot) return null;
      if (this.deadlineFor(slot, holidays).getTime() > now.getTime()) return slot;
      cursor = slot;
    }
    return null;
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
