import { Injectable } from '@nestjs/common';
import type { CalendarContract } from '../../application/calendar/contract';
import { CalendarLogRepository, type CalendarLogRow, type CalendarLogStatus, type NewCalendarLog } from '../../application/ports/calendar';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from './prisma.service';

type Row = NonNullable<Awaited<ReturnType<PrismaService['calendarParseLog']['findFirst']>>>;

const toRow = (r: Row): CalendarLogRow => ({
  id: r.id,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  sourceUrl: r.sourceUrl,
  sourceSha256: r.sourceSha256,
  term: r.term,
  status: r.status as CalendarLogStatus,
  verified: r.verified,
  warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
  contract: (r.contract as CalendarContract | null) ?? null,
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  seen: r.seen,
  seenBy: r.seenBy,
  seenAt: r.seenAt,
});

const data = (r: NewCalendarLog) => ({
  sourceUrl: r.sourceUrl,
  sourceSha256: r.sourceSha256,
  term: r.term,
  status: r.status,
  verified: r.verified,
  warnings: r.warnings as Prisma.InputJsonValue,
  contract: r.contract === null ? Prisma.DbNull : (r.contract as unknown as Prisma.InputJsonValue),
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
});

/** Log da leitura semanal do calendário (`calendar_parse_logs`). Conteúdo público; sem dado pessoal. */
@Injectable()
export class PrismaCalendarLogRepository extends CalendarLogRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findBySha(sha256: string) {
    const r = await this.prisma.calendarParseLog.findUnique({ where: { sourceSha256: sha256 } });
    return r ? toRow(r) : null;
  }

  async findErrorByUrl(url: string) {
    const r = await this.prisma.calendarParseLog.findFirst({
      where: { sourceUrl: url, status: 'ERROR', sourceSha256: null },
      orderBy: { createdAt: 'desc' },
    });
    return r ? toRow(r) : null;
  }

  async create(row: NewCalendarLog) {
    return toRow(await this.prisma.calendarParseLog.create({ data: data(row) }));
  }

  async update(id: string, row: NewCalendarLog) {
    return toRow(await this.prisma.calendarParseLog.update({ where: { id }, data: { ...data(row), updatedAt: new Date() } }));
  }

  async markSeen(id: string, userId: string, at: Date) {
    const found = await this.prisma.calendarParseLog.findUnique({ where: { id } });
    if (!found) return null;
    return toRow(await this.prisma.calendarParseLog.update({ where: { id }, data: { seen: true, seenBy: userId, seenAt: at } }));
  }

  async listUnseenProblems() {
    const rows = await this.prisma.calendarParseLog.findMany({
      where: { seen: false, status: { not: 'PUBLISHED' } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRow);
  }

  async knownTerms() {
    const rows = await this.prisma.calendarParseLog.findMany({ where: { term: { not: null } }, distinct: ['term'], select: { term: true } });
    return rows.map((r) => r.term!).filter(Boolean);
  }

  async listPublished() {
    const rows = await this.prisma.calendarParseLog.findMany({
      where: { status: 'PUBLISHED', term: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    const latest = new Map<string, CalendarLogRow>();
    for (const r of rows) if (r.term && !latest.has(r.term)) latest.set(r.term, toRow(r));
    return [...latest.values()];
  }
}
