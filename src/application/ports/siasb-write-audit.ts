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
  /**
   * Há registro de `procedure_add` com resultado `ok` desta pessoa, neste atendimento, com este id de procedimento?
   * É a trava de `clinica_excluir_procedimento`: só se exclui por aqui o que foi incluído por aqui.
   */
  abstract hasProcedureAdd(userId: string, attendanceId: string, targetId: string): Promise<boolean>;
}
