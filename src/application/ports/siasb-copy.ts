import type { EncryptedSecret } from './repositories';

/** Atendimento (paciente) do aluno no SIASB. Só o primeiro nome do paciente, cifrado. */
export interface SyncedAttendance {
  id: string;
  disciplineId: string;
  disciplineName: string;
  treatmentType: 'TRIAGE' | 'PLANNING' | 'URGENCY' | 'UNKNOWN';
  concluded: boolean;
  firstName: EncryptedSecret;
}

export interface SyncedSession {
  id: string;
  attendanceId: string;
  disciplineId: string;
  disciplineName: string;
  professorName: string;
  locationName: string;
  startAt: Date;
  endAt: Date;
  rescheduledStartAt: Date | null;
  statusLabel: string;
}

export type SyncResult = 'OK' | 'RECONNECT_REQUIRED' | 'UNAVAILABLE';

export interface SyncState {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  result: SyncResult | null;
  nextRunAt: Date | null;
}

/**
 * Cópia por aluno das sessões e atendimentos do SIASB (fase 2A). Janelas são inclusivas nas duas pontas
 * (`from <= startAt <= to`).
 */
export abstract class SiasbCopyRepository {
  /**
   * false (e nada gravado) se a pessoa não tem conta SIASB no momento da gravação. Atendimentos: substitui todos.
   * Sessões: apaga as de `window` (e as de mesmo id das novas) e grava as novas; as de fora ficam. Tudo numa transação.
   */
  abstract replaceWindow(
    userId: string,
    window: { from: Date; to: Date },
    data: { attendances: SyncedAttendance[]; sessions: SyncedSession[] },
  ): Promise<boolean>;
  /** Ordenadas por `startAt`. */
  abstract sessions(userId: string, from: Date, to: Date): Promise<SyncedSession[]>;
  abstract attendances(userId: string): Promise<SyncedAttendance[]>;
  /** Cópia e estado. */
  abstract deleteAll(userId: string): Promise<void>;
  abstract state(userId: string): Promise<SyncState | null>;
  /** `lastSuccessAt = at` só se `OK`; falha não apaga o último sucesso. */
  abstract recordAttempt(userId: string, r: { result: SyncResult; at: Date; nextRunAt: Date | null }): Promise<void>;
  /** false se a trava vale (outra execução em curso). */
  abstract claim(userId: string, now: Date, leaseMs: number): Promise<boolean>;
  abstract release(userId: string): Promise<void>;
  /**
   * Conta SIASB `OK` e (sem estado, ou `nextRunAt <= now`, ou estado criado só pela trava, sem tentativa nem agenda),
   * por `nextRunAt` crescente (sem estado primeiro).
   */
  abstract dueUsers(now: Date, limit: number): Promise<string[]>;
}
