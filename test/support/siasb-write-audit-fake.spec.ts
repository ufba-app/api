import { InMemorySiasbWriteAudit } from './siasb-write-audit-fake';

const AT = new Date('2026-11-16T12:00:00Z');

describe('InMemorySiasbWriteAudit', () => {
  it('guarda só os campos permitidos e some com a pessoa', async () => {
    const repo = new InMemorySiasbWriteAudit();
    await repo.record({ userId: 'u1', kind: 'unschedule', attendanceId: 'a', targetId: 's', result: 'unknown', at: AT, extra: 'x' } as never);
    await repo.record({ userId: 'u2', kind: 'schedule', result: 'ok', at: AT });
    expect(Object.keys(repo.rows[0]).sort()).toEqual(['at', 'attendanceId', 'kind', 'result', 'targetId', 'userId']);
    repo.deleteUser('u1');
    expect(repo.rows.map((r) => r.userId)).toEqual(['u2']);
  });
});

describe('InMemorySiasbWriteAudit.hasProcedureAdd', () => {
  it('só procedure_add ok da mesma pessoa, atendimento e id', async () => {
    const repo = new InMemorySiasbWriteAudit();
    await repo.record({ userId: 'u1', kind: 'procedure_add', attendanceId: '10', targetId: '55', result: 'ok', at: AT });
    await repo.record({ userId: 'u1', kind: 'procedure_add', attendanceId: '10', targetId: '66', result: 'unknown', at: AT });
    await repo.record({ userId: 'u1', kind: 'procedure_remove', attendanceId: '10', targetId: '77', result: 'ok', at: AT });
    expect(await repo.hasProcedureAdd('u1', '10', '55')).toBe(true);
    expect(await repo.hasProcedureAdd('u2', '10', '55')).toBe(false);
    expect(await repo.hasProcedureAdd('u1', '11', '55')).toBe(false);
    expect(await repo.hasProcedureAdd('u1', '10', '66')).toBe(false);
    expect(await repo.hasProcedureAdd('u1', '10', '77')).toBe(false);
  });
});
