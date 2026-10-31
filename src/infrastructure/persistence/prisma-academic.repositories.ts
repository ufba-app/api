import { Injectable } from '@nestjs/common';
import type { TranscriptData } from '../../domain/academic';
import {
  AttachmentLocation,
  AttachmentLookup,
  TranscriptRepository,
} from '../../application/ports/academic-ports';
import { PrismaService } from './prisma.service';

/** Grava o histórico: um por usuário, substituído a cada importação (transação). */
@Injectable()
export class PrismaTranscriptRepository extends TranscriptRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async save(userId: string, d: TranscriptData): Promise<Date> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.transcript.deleteMany({ where: { userId } });
      return tx.transcript.create({
        data: {
          userId,
          issuedAt: new Date(d.issuedAt),
          curriculumCode: d.curriculumCode,
          programName: d.programName,
          currentTerm: d.currentTerm,
          standardTerms: d.standardTerms,
          maxTerms: d.maxTerms,
          cr: d.cr,
          iap: d.iap,
          hoursMatrix: d.hoursMatrix as unknown as object,
          equivalences: d.equivalences,
          notes: d.notes,
          entries: { create: d.entries.map((e) => ({ ...e })) },
          pending: { create: d.pending.map((p) => ({ ...p })) },
        },
        select: { fetchedAt: true },
      });
    });
    return row.fetchedAt;
  }
}

/** Anexo do usuário, achado pelos ids do banco; sempre filtrado pelo dono da conta. */
@Injectable()
export class PrismaAttachmentLookup extends AttachmentLookup {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async find(
    userId: string,
    itemId: string,
    attachmentId: string,
  ): Promise<AttachmentLocation | null> {
    const a = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        itemId,
        item: { deletedAt: null, sourceAccount: { userId } },
      },
      include: { item: { select: { sourceAccountId: true, sourceAccount: { select: { provider: true } } } } },
    });
    if (!a) return null;
    return {
      provider: a.item.sourceAccount.provider,
      sourceAccountId: a.item.sourceAccountId,
      ref: { externalId: a.externalId, name: a.name, mimeType: a.mimeType, sourceUrl: a.sourceUrl },
    };
  }
}
