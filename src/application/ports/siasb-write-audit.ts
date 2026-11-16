export type SiasbWriteKind = 'schedule' | 'unschedule' | 'procedure_add' | 'procedure_remove';
export type SiasbWriteResult = 'ok' | 'rejected' | 'unknown' | 'error';

/** Só metadados da escrita: nunca texto livre, nome, observação ou mensagem do SIASB. */
export interface SiasbWriteAuditEntry {
  userId: string;
  kind: SiasbWriteKind;
  attendanceId?: string;
  /** Id da sessão ou do procedimento. */
  targetId?: string;
  result: SiasbWriteResult;
  at: Date;
}

export abstract class SiasbWriteAuditRepository {
  abstract record(e: SiasbWriteAuditEntry): Promise<void>;
}
