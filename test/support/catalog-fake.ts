import {
  CatalogRepository,
  CatalogSource,
  type ActiveCurriculumData,
  type CatalogComponent,
  type CatalogCurriculum,
  type CatalogProgram,
} from '../../src/application/ports/catalog';

/** Catálogo em memória (mesma semântica do repositório do Postgres: só o currículo Ativo por curso). */
export class InMemoryCatalog extends CatalogRepository {
  programs = new Map<string, CatalogProgram>();
  programsAt: Date | null = null;
  curricula = new Map<string, CatalogCurriculum>();
  components = new Map<string, CatalogComponent[]>();

  async listPrograms() {
    return [...this.programs.values()];
  }
  async programsUpdatedAt() {
    return this.programsAt;
  }
  async savePrograms(programs: CatalogProgram[]) {
    for (const p of programs) this.programs.set(p.sigaaId, p);
    this.programsAt = new Date();
  }
  async findCurriculum(programId: string) {
    return this.curricula.get(programId) ?? null;
  }
  async findComponents(programId: string) {
    return this.components.get(programId) ?? [];
  }
  async replaceCurriculum(programId: string, data: ActiveCurriculumData, fetchedAt: Date) {
    const { components, ...c } = data;
    this.curricula.set(programId, { ...c, programId, fetchedAt });
    this.components.set(programId, components);
  }
  async touchCurriculum(programId: string, fetchedAt: Date) {
    const c = this.curricula.get(programId);
    if (c) this.curricula.set(programId, { ...c, fetchedAt });
  }
}

export const sampleCurriculum = (code = 'G20251', sigaaId = '9001'): ActiveCurriculumData => ({
  sigaaId,
  code,
  implementationTerm: '2025.2',
  totalHours: 3610,
  requiredHours: 3150,
  minElectiveHours: 360,
  minComplementaryHours: 100,
  minTerms: 12,
  avgTerms: 12,
  maxTerms: 18,
  components: [
    {
      sigaaId: '1',
      code: 'FISD36',
      name: 'FÍSICA GERAL TEÓRICA I',
      hours: 60,
      nature: 'REQUIRED',
      term: 1,
      responsibleUnit: null,
      prerequisiteExpr: null,
      corequisiteExpr: null,
      equivalenceExpr: '( FISD36A )',
    },
  ],
});

/** Fonte falsa que conta as chamadas e deixa o teste escolher o que o SIGAA "diz". */
export class FakeCatalogSource extends CatalogSource {
  programs: CatalogProgram[] = [];
  activeCode = 'G20251';
  calls = { list: 0, code: 0, fetch: 0 };
  delayMs = 0;

  async listPrograms() {
    this.calls.list++;
    return this.programs;
  }
  async activeCurriculumCode() {
    this.calls.code++;
    return this.activeCode;
  }
  async fetchActiveCurriculum() {
    this.calls.fetch++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return sampleCurriculum(this.activeCode);
  }
}
