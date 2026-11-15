import { Logger } from '@nestjs/common';
import {
  CatalogRepository,
  CatalogSource,
  type CatalogComponent,
  type CatalogCurriculum,
  type CatalogProgram,
} from '../ports/catalog';
import { CurriculumGraphCache, type CurriculumView } from './curriculum-graph-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Depois disso, a chegada de um aluno novo dispara a checagem barata do currículo Ativo. */
export const CATALOG_TTL_MS = 30 * DAY_MS;

export class ProgramNotFoundError extends Error {
  constructor() {
    super('Curso não encontrado no catálogo público do SIGAA.');
    this.name = 'ProgramNotFoundError';
  }
}

export class NoActiveCurriculumError extends Error {
  constructor() {
    super('O SIGAA não marca nenhuma estrutura curricular como Ativa para este curso.');
    this.name = 'NoActiveCurriculumError';
  }
}

export interface CatalogEntry {
  program: CatalogProgram;
  curriculum: CatalogCurriculum;
}

/**
 * "ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador" (como o portal do discente escreve o curso) ou o nome puro do histórico.
 * Devolve o nome e, se houver, o campus.
 */
export function splitProgramName(raw: string): { name: string; campus?: string } {
  const [beforeDash, afterDash] = raw.split(' - ');
  const [name] = beforeDash.split('/');
  return { name: name.trim(), campus: afterDash?.trim() || undefined };
}

const upper = (s: string) => s.trim().toUpperCase();
/** O SIGAA escreve o mesmo curso ora "DE COMPUTAÇÃO", ora "DA COMPUTAÇÃO": as preposições não entram na comparação. */
const normalizeName = (s: string) =>
  upper(s)
    .replace(/\b(DE|DA|DO|DAS|DOS)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Catálogo do curso (docs/specs/2026-11-15-vida-academica.md §4.1). A unidade é o **curso**, sempre no currículo
 * **Ativo** (na UFBA todos os alunos se adequam ao mais novo). Importa só quando falta; com mais de 30 dias faz uma
 * checagem barata (a lista de estruturas) e só refaz a estrutura inteira se o Ativo mudou. Uma importação por curso por
 * vez: chamadas simultâneas esperam a mesma. Público, sem login e sem senha de ninguém.
 */
export class CatalogService {
  private readonly log = new Logger('Catalog');
  private readonly running = new Map<string, Promise<CatalogEntry>>();
  private readonly views: CurriculumGraphCache;

  constructor(
    private readonly repo: CatalogRepository,
    private readonly source: CatalogSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.views = new CurriculumGraphCache(repo, now);
  }

  /**
   * Acha o curso de graduação pelo nome do portal ("NOME/UNIDADE - Campus") ou do histórico. Com mais de um candidato, o
   * campus desempata; sem solução única, lança `ProgramNotFoundError`.
   */
  async findProgram(rawName: string): Promise<CatalogProgram> {
    const { name, campus } = splitProgramName(rawName);
    const programs = (await this.programs()).filter((p) => p.level === 'G' && normalizeName(p.name) === normalizeName(name));
    const byCampus = campus ? programs.filter((p) => upper(p.campus) === upper(campus)) : programs;
    const pick = byCampus.length > 0 ? byCampus : programs;
    if (pick.length !== 1) throw new ProgramNotFoundError();
    return pick[0];
  }

  /** Garante o currículo Ativo do curso (importa se faltar ou mudou) e o devolve. */
  ensureCurriculum(programId: string): Promise<CatalogEntry> {
    const current = this.running.get(programId);
    if (current) return current;
    const run = this.doEnsure(programId).finally(() => this.running.delete(programId));
    this.running.set(programId, run);
    return run;
  }

  /** Há uma importação deste curso em andamento agora? */
  importing(programId: string): boolean {
    return this.running.has(programId);
  }

  /** O que está guardado, sem tocar no SIGAA. */
  async read(programId: string): Promise<{ curriculum: CatalogCurriculum; components: CatalogComponent[] } | null> {
    const curriculum = await this.repo.findCurriculum(programId);
    return curriculum ? { curriculum, components: await this.repo.findComponents(programId) } : null;
  }

  /** O currículo guardado com o grafo montado, em cache (não toca no banco dentro do prazo nem no SIGAA). */
  readView(programId: string): Promise<CurriculumView | null> {
    return this.views.forProgram(programId);
  }

  private async doEnsure(programId: string): Promise<CatalogEntry> {
    const program = (await this.programs()).find((p) => p.sigaaId === programId);
    if (!program) throw new ProgramNotFoundError();

    const saved = await this.repo.findCurriculum(programId);
    if (saved && this.now().getTime() - saved.fetchedAt.getTime() <= CATALOG_TTL_MS) return { program, curriculum: saved };

    if (saved) {
      // Checagem barata: o Ativo mudou? Só então refaz tudo.
      const code = await this.source.activeCurriculumCode(programId);
      if (code === saved.code) {
        await this.repo.touchCurriculum(programId, this.now());
        this.views.invalidate(programId);
        return { program, curriculum: { ...saved, fetchedAt: this.now() } };
      }
      this.log.log(`currículo Ativo do curso ${programId} mudou (${saved.code} → ${code}): refazendo a estrutura`);
    }

    const data = await this.source.fetchActiveCurriculum(programId);
    const fetchedAt = this.now();
    await this.repo.replaceCurriculum(programId, data, fetchedAt);
    this.views.invalidate(programId);
    const { components, ...curriculum } = data;
    this.log.log(`estrutura do curso ${programId} importada: ${curriculum.code}, ${components.length} componentes`);
    return { program, curriculum: { ...curriculum, programId, fetchedAt } };
  }

  /** Lista de cursos: do banco, e do SIGAA quando nunca foi populada ou tem mais de 30 dias. */
  private async programs(): Promise<CatalogProgram[]> {
    const saved = await this.repo.listPrograms();
    const updatedAt = saved.length > 0 ? await this.repo.programsUpdatedAt() : null;
    if (updatedAt && this.now().getTime() - updatedAt.getTime() <= CATALOG_TTL_MS) return saved;
    const fresh = await this.source.listPrograms();
    await this.repo.savePrograms(fresh);
    return fresh;
  }
}
