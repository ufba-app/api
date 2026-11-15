import { Injectable } from '@nestjs/common';
import {
  CatalogRepository,
  type ActiveCurriculumData,
  type CatalogComponent,
  type CatalogCurriculum,
  type CatalogProgram,
} from '../../application/ports/catalog';
import { PrismaService } from './prisma.service';

/** Catálogo público no Postgres (`programs`, `curricula`, `curriculum_components`). Só dado público, sem dono. */
@Injectable()
export class PrismaCatalogRepository extends CatalogRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listPrograms(): Promise<CatalogProgram[]> {
    const rows = await this.prisma.program.findMany();
    return rows.map((r) => ({ sigaaId: r.sigaaId, name: r.name, campus: r.campus, level: r.level }));
  }

  async programsUpdatedAt(): Promise<Date | null> {
    const r = await this.prisma.program.aggregate({ _max: { updatedAt: true } });
    return r._max.updatedAt ?? null;
  }

  async savePrograms(programs: CatalogProgram[]): Promise<void> {
    const now = new Date();
    // Upsert, nunca apagar: um curso que some da lista não leva junto (em cascata) o currículo que já importamos.
    await this.prisma.$transaction(
      programs.map((p) =>
        this.prisma.program.upsert({
          where: { sigaaId: p.sigaaId },
          create: { sigaaId: p.sigaaId, name: p.name, campus: p.campus, level: p.level, updatedAt: now },
          update: { name: p.name, campus: p.campus, level: p.level, updatedAt: now },
        }),
      ),
    );
  }

  async findCurriculum(programId: string): Promise<CatalogCurriculum | null> {
    const r = await this.prisma.curriculum.findFirst({ where: { programId }, orderBy: { fetchedAt: 'desc' } });
    if (!r) return null;
    return {
      sigaaId: r.sigaaId,
      programId: r.programId,
      code: r.code,
      implementationTerm: r.implementationTerm,
      totalHours: r.totalHours,
      requiredHours: r.requiredHours,
      minElectiveHours: r.minElectiveHours,
      minComplementaryHours: r.minComplementaryHours,
      minTerms: r.minTerms,
      avgTerms: r.avgTerms,
      maxTerms: r.maxTerms,
      fetchedAt: r.fetchedAt,
    };
  }

  async findComponents(programId: string): Promise<CatalogComponent[]> {
    const curriculum = await this.prisma.curriculum.findFirst({ where: { programId }, orderBy: { fetchedAt: 'desc' }, select: { sigaaId: true } });
    if (!curriculum) return [];
    const rows = await this.prisma.curriculumComponent.findMany({ where: { curriculumId: curriculum.sigaaId }, orderBy: [{ term: 'asc' }, { code: 'asc' }] });
    return rows.map((c) => ({
      sigaaId: c.sigaaId,
      code: c.code,
      name: c.name,
      hours: c.hours,
      nature: c.nature,
      term: c.term,
      responsibleUnit: c.responsibleUnit,
      prerequisiteExpr: c.prerequisiteExpr,
      corequisiteExpr: c.corequisiteExpr,
      equivalenceExpr: c.equivalenceExpr,
    }));
  }

  async replaceCurriculum(programId: string, data: ActiveCurriculumData, fetchedAt: Date): Promise<void> {
    const { components, ...c } = data;
    await this.prisma.$transaction([
      // Só o Ativo é guardado: o anterior (e seus componentes, em cascata) sai.
      this.prisma.curriculum.deleteMany({ where: { programId } }),
      this.prisma.curriculum.create({
        data: {
          sigaaId: c.sigaaId,
          programId,
          code: c.code,
          implementationTerm: c.implementationTerm,
          totalHours: c.totalHours,
          requiredHours: c.requiredHours,
          minElectiveHours: c.minElectiveHours,
          minComplementaryHours: c.minComplementaryHours,
          minTerms: c.minTerms,
          avgTerms: c.avgTerms,
          maxTerms: c.maxTerms,
          fetchedAt,
          components: {
            create: components.map((k) => ({
              sigaaId: k.sigaaId,
              code: k.code,
              name: k.name,
              hours: k.hours,
              nature: k.nature,
              term: k.term,
              responsibleUnit: k.responsibleUnit,
              prerequisiteExpr: k.prerequisiteExpr,
              corequisiteExpr: k.corequisiteExpr,
              equivalenceExpr: k.equivalenceExpr,
            })),
          },
        },
      }),
    ]);
  }

  async touchCurriculum(programId: string, fetchedAt: Date): Promise<void> {
    await this.prisma.curriculum.updateMany({ where: { programId }, data: { fetchedAt } });
  }
}
