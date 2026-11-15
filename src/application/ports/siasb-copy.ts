import type { EncryptedSecret } from './repositories';

/** Disciplina clínica do aluno no SIASB (inclusive sem paciente). O nome não é segredo. */
export interface SyncedDiscipline {
  id: string;
  name: string;
}

/** Atendimento (paciente) do aluno no SIASB. Só o primeiro nome do paciente, cifrado. */
export interface SyncedAttendance {
  id: string;
  disciplineId: string;
  disciplineName: string;
  treatmentType: 'TRIAGE' | 'PLANNING' | 'URGENCY' | 'UNKNOWN';
  concluded: boolean;
  /** Veio da consulta de atendimentos ATIVOS do SIASB (não se deduz de `concluded`). */
  active: boolean;
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

export type ClaimResult = 'claimed' | 'busy' | 'no_account';

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
   * false (e nada gravado) se a pessoa não tem conta SIASB no momento da gravação. Disciplinas e atendimentos: substitui todos.
   * Sessões: apaga as de `window` (e as de mesmo id das novas) e grava as novas; as de fora ficam. Tudo numa transação que trava a linha da conta SIASB (FOR SHARE):
   * uma desconexão concorrente espera o commit e o `deleteAll` dela, depois, apaga o que foi gravado.
   */
  abstract replaceWindow(
    userId: string,
    window: { from: Date; to: Date },
    data: { disciplines: SyncedDiscipline[]; attendances: SyncedAttendance[]; sessions: SyncedSession[] },
  ): Promise<boolean>;
  /** Ordenadas por `startAt`. */
  abstract sessions(userId: string, from: Date, to: Date): Promise<SyncedSession[]>;
  abstract attendances(userId: string): Promise<SyncedAttendance[]>;
  /** Ordenadas por nome. */
  abstract disciplines(userId: string): Promise<SyncedDiscipline[]>;
  /** Cópia e estado. */
  abstract deleteAll(userId: string): Promise<void>;
  abstract state(userId: string): Promise<SyncState | null>;
  /** `lastSuccessAt = at` só se `OK`; falha não apaga o último sucesso. Sem linha de estado, não faz nada (ela nasce no `claim`). */
  abstract recordAttempt(userId: string, r: { result: SyncResult; at: Date; nextRunAt: Date | null }): Promise<void>;
  /**
   * Cria a linha de estado SÓ se a pessoa tem conta SIASB e toma a trava. `'busy'` se a trava vale (outra execução em
   * curso); `'no_account'` se não há conta nem linha (nada é criado).
   */
  abstract claim(userId: string, now: Date, leaseMs: number): Promise<ClaimResult>;
  abstract release(userId: string): Promise<void>;
  /**
   * Conta SIASB `OK` e (sem estado, ou sem agenda, ou `nextRunAt <= now`), por `nextRunAt` crescente (sem estado e sem
   * agenda primeiro). Sem agenda cobre a reconexão depois de `RECONNECT_REQUIRED` (que grava `nextRunAt = null`).
   */
  abstract dueUsers(now: Date, limit: number): Promise<string[]>;
}
