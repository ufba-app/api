/** Catálogo público de cursos da UFBA: global, idêntico para todo aluno, sem dono. */

export interface CatalogProgram {
  /** Id do curso no SIGAA. */
  sigaaId: string;
  name: string;
  campus: string;
  /** G = graduação. */
  level: string;
}

export type CatalogNature = 'REQUIRED' | 'ELECTIVE' | 'COMPLEMENTARY';

export interface CatalogComponent {
  /** Id do componente no SIGAA. */
  sigaaId: string;
  code: string;
  name: string;
  hours: number;
  nature: CatalogNature;
  /** Semestre sugerido; nulo para optativas e complementares. */
  term: number | null;
  responsibleUnit: string | null;
  /** Expressões como o SIGAA escreve: "( FISD36 E FISD42 ) OU ( ENGJ18 )". Interpretadas no domínio. */
  prerequisiteExpr: string | null;
  corequisiteExpr: string | null;
  equivalenceExpr: string | null;
}

export interface CatalogCurriculum {
  /** Id da estrutura curricular no SIGAA. */
  sigaaId: string;
  programId: string;
  /** "G20251". */
  code: string;
  implementationTerm: string;
  totalHours: number;
  requiredHours: number;
  minElectiveHours: number;
  minComplementaryHours: number;
  minTerms: number;
  avgTerms: number;
  maxTerms: number;
  fetchedAt: Date;
}

export type ActiveCurriculumData = Omit<CatalogCurriculum, 'programId' | 'fetchedAt'> & { components: CatalogComponent[] };

/** De onde o catálogo vem (páginas públicas do SIGAA, sem login). */
export abstract class CatalogSource {
  /** Todos os cursos listados (a lista pública traz todos os níveis). */
  abstract listPrograms(): Promise<CatalogProgram[]>;
  /** Código da estrutura que o SIGAA marca como "Ativa" (1 a 2 requisições: checagem barata). */
  abstract activeCurriculumCode(programId: string): Promise<string>;
  /** A estrutura Ativa inteira, com o detalhe de cada componente (dezenas de requisições, em sequência). */
  abstract fetchActiveCurriculum(programId: string): Promise<ActiveCurriculumData>;
}

export abstract class CatalogRepository {
  abstract listPrograms(): Promise<CatalogProgram[]>;
  /** Quando a lista de cursos foi gravada pela última vez; `null` se nunca. */
  abstract programsUpdatedAt(): Promise<Date | null>;
  abstract savePrograms(programs: CatalogProgram[]): Promise<void>;
  abstract findCurriculum(programId: string): Promise<CatalogCurriculum | null>;
  abstract findComponents(programId: string): Promise<CatalogComponent[]>;
  /** Troca o currículo do curso pelo novo (só o Ativo é guardado) e seus componentes, numa transação. */
  abstract replaceCurriculum(programId: string, data: ActiveCurriculumData, fetchedAt: Date): Promise<void>;
  /** O currículo continua o mesmo: só renova o `fetchedAt`. */
  abstract touchCurriculum(programId: string, fetchedAt: Date): Promise<void>;
}
