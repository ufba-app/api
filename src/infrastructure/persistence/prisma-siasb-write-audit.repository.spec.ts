import { PrismaSiasbWriteAuditRepository } from './prisma-siasb-write-audit.repository';
import type { PrismaService } from './prisma.service';

const U = '0192b3c4-0000-7000-8000-000000000001';
const AT = new Date('2026-11-16T12:00:00Z');

function setup() {
  const prisma = { siasbWriteAudit: { create: jest.fn().mockResolvedValue({}) } };
  return { repo: new PrismaSiasbWriteAuditRepository(prisma as unknown as PrismaService), prisma };
}

describe('PrismaSiasbWriteAuditRepository', () => {
  it('record grava só os campos permitidos, com opcionais nulos', async () => {
    const { repo, prisma } = setup();
    await repo.record({ userId: U, kind: 'schedule', result: 'ok', at: AT });
    expect(prisma.siasbWriteAudit.create).toHaveBeenCalledWith({
      data: { userId: U, kind: 'schedule', attendanceId: null, targetId: null, result: 'ok', at: AT },
    });
  });

  it('record ignora campo extra (texto livre) que chegue por engano', async () => {
    const { repo, prisma } = setup();
    await repo.record({
      userId: U,
      kind: 'procedure_add',
      attendanceId: 'a1',
      targetId: 'p1',
      result: 'rejected',
      at: AT,
      message: 'texto do SIASB',
      patientName: 'Fulano',
    } as never);
    expect(Object.keys(prisma.siasbWriteAudit.create.mock.calls[0][0].data).sort()).toEqual(
      ['at', 'attendanceId', 'kind', 'result', 'targetId', 'userId'],
    );
  });
});
