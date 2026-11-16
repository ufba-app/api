import { SiasbWriteAuditRepository, type SiasbWriteAuditEntry } from '../../src/application/ports/siasb-write-audit';

export class InMemorySiasbWriteAudit extends SiasbWriteAuditRepository {
  rows: SiasbWriteAuditEntry[] = [];

  async record(e: SiasbWriteAuditEntry): Promise<void> {
    this.rows.push({
      userId: e.userId,
      kind: e.kind,
      attendanceId: e.attendanceId,
      targetId: e.targetId,
      result: e.result,
      at: e.at,
    });
  }

  async hasProcedureAdd(userId: string, attendanceId: string, targetId: string): Promise<boolean> {
    return this.rows.some(
      (r) =>
        r.userId === userId &&
        r.kind === 'procedure_add' &&
        r.result === 'ok' &&
        r.attendanceId === attendanceId &&
        r.targetId === targetId,
    );
  }

  /** Como o cascade do Postgres ao apagar a pessoa. */
  deleteUser(userId: string): void {
    this.rows = this.rows.filter((r) => r.userId !== userId);
  }
}
