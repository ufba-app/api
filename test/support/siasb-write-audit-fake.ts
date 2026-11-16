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

  /** Como o cascade do Postgres ao apagar a pessoa. */
  deleteUser(userId: string): void {
    this.rows = this.rows.filter((r) => r.userId !== userId);
  }
}
