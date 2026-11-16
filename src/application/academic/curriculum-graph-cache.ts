import { buildCurriculumGraph, type CurriculumGraph } from '../../domain/academic/curriculum-graph';
import { CatalogRepository, type CatalogComponent, type CatalogCurriculum } from '../ports/catalog';

/** Quanto tempo o grafo vale sem nem perguntar ao banco. Depois disso confere a versão (uma linha) e só remonta se mudou. */
export const GRAPH_CACHE_TTL_MS = 5 * 60_000;

/** O currículo Ativo do curso como a rota o usa: a linha, os componentes e o grafo montado deles. */
export interface CurriculumView {
  curriculum: CatalogCurriculum;
  components: CatalogComponent[];
  graph: CurriculumGraph;
}

interface Entry {
  /** Currículo + `fetchedAt`: muda quando a importação grava outro currículo ou renova o atual. */
  version: string;
  view: CurriculumView;
  checkedAt: number;
}

/**
 * Cache em memória do grafo do currículo Ativo de cada curso (docs/specs/2026-11-15-curriculo-grafo.md §5).
 *
 * Guarda só o currículo e o grafo dele, que são públicos e iguais para todo aluno: nunca histórico nem dado de pessoa. O que
 * é da pessoa entra no cálculo por cima, não no cache. Cada instância tem o seu; o dado é pequeno e idêntico em todas.
 *
 * Dentro do prazo não toca no banco. Passado o prazo, lê só a linha do currículo: mesma versão renova o prazo, versão
 * nova lê os componentes e remonta. Montagens simultâneas do mesmo curso se juntam numa só.
 */
export class CurriculumGraphCache {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<CurriculumView | null>>();

  constructor(
    private readonly repo: CatalogRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = GRAPH_CACHE_TTL_MS,
  ) {}

  /** O currículo Ativo do curso (com o grafo), ou `null` se o curso ainda não tem currículo importado. */
  async forProgram(programId: string): Promise<CurriculumView | null> {
    const cached = this.entries.get(programId);
    if (cached && this.now().getTime() - cached.checkedAt < this.ttlMs) return cached.view;

    const running = this.loading.get(programId);
    if (running) return running;
    const load = this.load(programId).finally(() => this.loading.delete(programId));
    this.loading.set(programId, load);
    return load;
  }

  /** Esquece o grafo do curso (a próxima leitura remonta). Sem argumento, esquece todos. */
  invalidate(programId?: string): void {
    if (programId === undefined) this.entries.clear();
    else this.entries.delete(programId);
  }

  private async load(programId: string): Promise<CurriculumView | null> {
    const curriculum = await this.repo.findCurriculum(programId);
    if (!curriculum) {
      this.entries.delete(programId);
      return null;
    }
    const version = `${curriculum.sigaaId}:${curriculum.fetchedAt.getTime()}`;
    const current = this.entries.get(programId);
    if (current && current.version === version) {
      current.checkedAt = this.now().getTime();
      return current.view;
    }
    const components = await this.repo.findComponents(programId);
    const view: CurriculumView = { curriculum, components, graph: buildCurriculumGraph(components) };
    this.entries.set(programId, { version, view, checkedAt: this.now().getTime() });
    return view;
  }
}
