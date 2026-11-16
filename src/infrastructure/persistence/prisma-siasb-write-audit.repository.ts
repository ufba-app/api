import { Injectable } from '@nestjs/common';
import { SiasbWriteAuditRepository, type SiasbWriteAuditEntry } from '../../application/ports/siasb-write-audit';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaSiasbWriteAuditRepository extends SiasbWriteAuditRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async record(e: SiasbWriteAuditEntry): Promise<void> {
    // lista explícita: nenhum campo extra do objeto recebido chega ao banco
    await this.prisma.siasbWriteAudit.create({
      data: {
        userId: e.userId,
        kind: e.kind,
        attendanceId: e.attendanceId ?? null,
        targetId: e.targetId ?? null,
        result: e.result,
        at: e.at,
      },
    });
  }

  async hasProcedureAdd(userId: string, attendanceId: string, targetId: string): Promise<boolean> {
    const row = await this.prisma.siasbWriteAudit.findFirst({
      where: { userId, kind: 'procedure_add', result: 'ok', attendanceId, targetId },
      select: { id: true },
    });
    return row !== null;
  }
}
