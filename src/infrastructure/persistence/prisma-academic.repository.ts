import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { TranscriptContract } from '../../application/academic/transcript/contract';
import {
  AcademicRepository,
  type ImportFailure,
  type ImportLogEntry,
  type ImportState,
  type PortalProfile,
} from '../../application/ports/academic';
import { PrismaService } from './prisma.service';

const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * Vida acadêmica no Postgres. Nada aqui é identidade (nome, CPF, nascimento) nem o PDF nem o texto enviado ao provedor:
 * só o contrato lido (que a pessoa confirma), contagens e o aceite. Tudo cai em cascata com a conta.
 */
@Injectable()
export class PrismaAcademicRepository extends AcademicRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getConsent(userId: string) {
    const r = await this.prisma.academicConsent.findUnique({ where: { userId } });
    return r ? { acceptedAt: r.acceptedAt, version: r.version } : null;
  }

  async saveConsent(userId: string, version: number, at: Date) {
    await this.prisma.academicConsent.upsert({
      where: { userId },
      create: { userId, version, acceptedAt: at },
      update: { version, acceptedAt: at },
    });
  }

  async deleteConsent(userId: string) {
    await this.prisma.academicConsent.deleteMany({ where: { userId } });
  }

  async getImport(userId: string): Promise<ImportState | null> {
    const r = await this.prisma.academicImport.findUnique({ where: { userId } });
    if (!r) return null;
    return {
      userId: r.userId,
      status: r.status,
      failure: (r.failure as ImportFailure | null) ?? null,
      programId: r.programId,
      draft: (r.draft as unknown as TranscriptContract | null) ?? null,
      profile: (r.profile as unknown as PortalProfile | null) ?? null,
      verified: r.verified,
      reader: r.reader,
      componentsCount: r.componentsCount,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      importedAt: r.importedAt,
    };
  }

  async saveImport(s: ImportState) {
    const data = {
      status: s.status,
      failure: s.failure,
      programId: s.programId,
      draft: s.draft === null ? Prisma.DbNull : toJson(s.draft),
      profile: s.profile === null ? Prisma.DbNull : toJson(s.profile),
      verified: s.verified,
      reader: s.reader,
      componentsCount: s.componentsCount,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      importedAt: s.importedAt,
    };
    await this.prisma.academicImport.upsert({
      where: { userId: s.userId },
      create: { userId: s.userId, ...data },
      update: data,
    });
  }

  async deleteImport(userId: string) {
    await this.prisma.academicImport.deleteMany({ where: { userId } });
  }

  async addLog(e: ImportLogEntry) {
    await this.prisma.academicImportLog.create({
      data: {
        userId: e.userId,
        startedAt: e.startedAt,
        result: e.result,
        verified: e.verified,
        componentsCount: e.componentsCount,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        latencyMs: e.latencyMs,
      },
    });
  }

  countLogsSince(userId: string, since: Date) {
    return this.prisma.academicImportLog.count({ where: { userId, startedAt: { gte: since } } });
  }

  async usageSince(since: Date) {
    const r = await this.prisma.academicImportLog.aggregate({
      where: { startedAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return { inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0 };
  }

  async replaceTranscript(userId: string, c: TranscriptContract) {
    // Chave do pendente: código + nome (o ENADE aparece duas vezes com nomes diferentes). Repetida igual não derruba a gravação.
    const pending = [...new Map(c.pendingMandatory.items.map((p) => [`${p.code}|${p.name}`, p])).values()];
    await this.prisma.$transaction([
      this.prisma.transcript.deleteMany({ where: { userId } }),
      this.prisma.transcript.create({
        data: {
          userId,
          issuedAt: new Date(c.document.issuedOn),
          curriculumCode: c.program.curriculum,
          programName: c.program.name,
          currentTerm: c.program.currentTerm,
          standardTerms: c.program.completionDeadline.standard,
          maxTerms: c.program.completionDeadline.maximum,
          cr: c.indices.cr,
          iap: c.indices.iap,
          hoursMatrix: toJson(c.hours),
          equivalences: c.equivalences,
          notes: c.notes,
          verified: c.verification.verified,
          reader: c.verification.reader,
          entries: {
            create: c.components.map((e) => ({
              term: e.term,
              nature: e.kind,
              code: e.code,
              name: e.name,
              hours: e.hours,
              grade: e.grade,
              status: e.status,
              instructor: null,
            })),
          },
          pending: { create: pending.map((p) => ({ code: p.code, name: p.name, hours: p.hours, enrolled: p.enrolled })) },
        },
      }),
    ]);
  }

  async findTranscript(userId: string): Promise<TranscriptContract | null> {
    const t = await this.prisma.transcript.findUnique({
      where: { userId },
      include: { entries: { orderBy: [{ term: 'asc' }, { code: 'asc' }] }, pending: true },
    });
    if (!t) return null;
    return {
      contractVersion: '1',
      document: { issuedOn: t.issuedAt.toISOString().slice(0, 10) },
      program: {
        name: t.programName,
        curriculum: t.curriculumCode,
        currentTerm: t.currentTerm,
        completionDeadline: { standard: t.standardTerms, maximum: t.maxTerms },
      },
      indices: { cr: t.cr ? Number(t.cr) : null, iap: t.iap ? Number(t.iap) : null },
      components: t.entries.map((e) => ({
        term: e.term,
        kind: e.nature,
        code: e.code,
        name: e.name,
        hours: e.hours,
        grade: e.grade === null ? null : Number(e.grade),
        status: e.status,
      })),
      hours: t.hoursMatrix as unknown as TranscriptContract['hours'],
      pendingMandatory: {
        declaredTotal: t.pending.length,
        items: t.pending.map((p) => ({ code: p.code, name: p.name, hours: p.hours, enrolled: p.enrolled })),
      },
      equivalences: t.equivalences,
      notes: t.notes,
      verification: { verified: t.verified, warnings: [], reader: t.reader === 'parser' ? 'parser' : 'ai' },
    };
  }

  async deleteTranscript(userId: string) {
    await this.prisma.transcript.deleteMany({ where: { userId } });
  }

  async saveProfile(userId: string, p: PortalProfile) {
    const data = { registration: p.registration, programName: p.program, entryTerm: p.entryTerm };
    await this.prisma.studentProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  async findProfile(userId: string) {
    const r = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!r || (r.registration === null && r.programName === null && r.entryTerm === null)) return null;
    return { registration: r.registration, program: r.programName, entryTerm: r.entryTerm };
  }

  async clearProfile(userId: string) {
    await this.prisma.studentProfile.updateMany({ where: { userId }, data: { registration: null, programName: null, entryTerm: null } });
  }
}
