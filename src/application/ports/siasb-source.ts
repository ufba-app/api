import { inspect } from 'node:util';
import type { Secret } from '../shared/secret';
import type {
  ClinicalAttendance,
  ClinicalDiscipline,
  ClinicalSession,
  Procedure,
} from '../../domain/siasb/types';

/**
 * Sessão do SIASB: o jar de cookies da pessoa. Os NOMES dos cookies também são sensíveis (um deles carrega a matrícula
 * no nome, `<matrícula>_idcurso`), por isso impressão, JSON e inspeção mostram só o resumo, nunca o jar.
 * Quem cifra e guarda o jar lê `cookies` de propósito.
 */
export class SiasbSession {
  constructor(
    public cookies: Record<string, string> = {},
    public expiresAt: Date | null = null,
    /** `true` quando uma resposta do SIASB renovou algum cookie e o jar precisa ser gravado de novo. */
    public dirty: boolean = false,
  ) {}

  toString(): string {
    return 'SiasbSession([redacted])';
  }

  toJSON(): { expiresAt: string | null; dirty: boolean } {
    return { expiresAt: this.expiresAt?.toISOString() ?? null, dirty: this.dirty };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export type SiasbErrorCode =
  | 'REAUTH_NEEDED'
  | 'PASSWORD_MIGRATION_REQUIRED'
  | 'CREDENTIAL_REJECTED'
  | 'UNAVAILABLE'
  | 'UNEXPECTED_FORMAT'
  | 'FORBIDDEN_ROUTE'
  /** O SIASB recusou a escrita (4xx exceto 401). */
  | 'WRITE_REJECTED'
  /** Resultado da escrita desconhecido (timeout, queda de rede, 5xx, redirecionamento). */
  | 'WRITE_UNKNOWN';

/** Erro do SIASB. A mensagem é fixa e nunca leva senha, cookie (valor ou nome), matrícula ou corpo de resposta. */
export class SiasbError extends Error {
  constructor(
    readonly code: SiasbErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SiasbError';
  }
}

export interface SiasbCourse {
  id: number;
  name: string;
  abbreviation: string;
  isDefault: boolean;
}

export interface SchedulingOption {
  id: string;
  name: string;
  preferred: boolean;
}

export interface SchedulingOptions {
  professors: SchedulingOption[];
  locations: SchedulingOption[];
  groups: SchedulingOption[];
}

export interface ScheduleSessionsInput {
  attendanceId: string;
  professorId: string;
  locationId: string;
  groupId: string;
  startAt: Date;
  endAt: Date;
  count: number;
  description: string;
}

export interface WriteResult {
  ok: true;
  createdId: string | null;
}

/** Porta do SIASB. Toda consulta recebe a sessão da pessoa; nada é copiado para o banco. */
export abstract class SiasbSource {
  abstract courseOptions(registration: string): Promise<SiasbCourse[]>;
  abstract login(
    registration: string,
    password: Secret,
    courseId: number,
  ): Promise<{ session: SiasbSession; username: string }>;
  abstract disciplines(session: SiasbSession): Promise<ClinicalDiscipline[]>;
  abstract attendances(session: SiasbSession, which: 'active' | 'inactive'): Promise<ClinicalAttendance[]>;
  abstract sessions(session: SiasbSession, from: Date, to: Date): Promise<ClinicalSession[]>;
  abstract procedures(session: SiasbSession, attendanceId: string): Promise<Procedure[]>;
  /** Quantos pacientes sem responsável existem, POR disciplina (id da disciplina como chave). */
  abstract unassignedCount(session: SiasbSession): Promise<Record<string, number>>;
  /** Professores, locais e grupos para agendar sessões deste atendimento. */
  abstract schedulingOptions(session: SiasbSession, attendanceId: string): Promise<SchedulingOptions>;
  abstract scheduleSessions(session: SiasbSession, input: ScheduleSessionsInput): Promise<WriteResult>;
  abstract unscheduleSession(session: SiasbSession, sessionId: string, reason: string): Promise<WriteResult>;
  abstract addProcedure(
    session: SiasbSession,
    attendanceId: string,
    input: { serviceId: number; teeth: string; faces: string; observation: string },
  ): Promise<WriteResult>;
  abstract removeProcedure(session: SiasbSession, attendanceId: string, procedureId: string): Promise<WriteResult>;
}
