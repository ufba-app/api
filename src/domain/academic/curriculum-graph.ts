import { citedCodes, parseExpression, type Expr } from './prerequisite';
import type { CurriculumComponentInput } from './progress';

/**
 * O currículo como grafo (docs/specs/2026-11-15-curriculo-grafo.md). Construído em memória a partir das expressões que o
 * SIGAA imprime; o texto continua sendo a fonte e nada aqui vai ao banco. Domínio puro, sem rede.
 *
 * Aresta: `from` é o código citado na expressão e `to` é o componente dono da expressão. Para `EQUIVALENCE`, `from` é o
 * código que, cumprido, cumpre `to`.
 */

export type EdgeRelation = 'PREREQUISITE' | 'COREQUISITE' | 'EQUIVALENCE';

/**
 * `REQUIRED`: o código é exigido em toda forma de satisfazer a expressão (linha contínua na tela).
 * `ALTERNATIVE`: aparece em um `OU` e basta uma das alternativas (linha tracejada).
 */
export type EdgeStrength = 'REQUIRED' | 'ALTERNATIVE';

export interface GraphEdge {
  from: string;
  to: string;
  relation: EdgeRelation;
  strength: EdgeStrength;
}

/** Expressão que não virou aresta: sem código (carga mínima, por exemplo) ou malformada. */
export interface UnparsedExpression {
  code: string;
  relation: EdgeRelation;
  text: string;
}

/** Códigos exigidos em toda forma de satisfazer a expressão: `E` une, `OU` interseciona. */
function requiredCodes(expr: Expr): Set<string> {
  if (expr.kind === 'CODE') return new Set([expr.code]);
  const left = requiredCodes(expr.left);
  const right = requiredCodes(expr.right);
  if (expr.kind === 'AND') return new Set([...left, ...right]);
  return new Set([...left].filter((c) => right.has(c)));
}

const RELATIONS: readonly { relation: EdgeRelation; field: 'prerequisiteExpr' | 'corequisiteExpr' | 'equivalenceExpr' }[] = [
  { relation: 'PREREQUISITE', field: 'prerequisiteExpr' },
  { relation: 'COREQUISITE', field: 'corequisiteExpr' },
  { relation: 'EQUIVALENCE', field: 'equivalenceExpr' },
];

export class CurriculumGraph {
  readonly components: ReadonlyMap<string, CurriculumComponentInput>;
  readonly edges: readonly GraphEdge[];
  readonly unparsed: readonly UnparsedExpression[];
  private readonly into = new Map<string, GraphEdge[]>();
  private readonly outOf = new Map<string, GraphEdge[]>();

  constructor(components: readonly CurriculumComponentInput[]) {
    this.components = new Map(components.map((c) => [c.code, c]));
    const edges: GraphEdge[] = [];
    const unparsed: UnparsedExpression[] = [];
    for (const component of components) {
      for (const { relation, field } of RELATIONS) {
        const text = component[field];
        if (!text || text.trim() === '') continue;
        const expr = parseExpression(text);
        if (!expr) {
          unparsed.push({ code: component.code, relation, text });
          continue;
        }
        const required = requiredCodes(expr);
        for (const cited of citedCodes(text)) {
          if (cited === component.code) continue; // uma matéria não depende de si mesma
          edges.push({ from: cited, to: component.code, relation, strength: required.has(cited) ? 'REQUIRED' : 'ALTERNATIVE' });
        }
      }
    }
    this.edges = edges;
    this.unparsed = unparsed;
    for (const e of edges) {
      this.into.set(e.to, [...(this.into.get(e.to) ?? []), e]);
      this.outOf.set(e.from, [...(this.outOf.get(e.from) ?? []), e]);
    }
  }

  /** Arestas que chegam em `code`: o que ele exige (ou o que o cumpre, no caso de equivalência). */
  incoming(code: string, relation?: EdgeRelation): GraphEdge[] {
    return (this.into.get(code) ?? []).filter((e) => !relation || e.relation === relation);
  }

  /** Arestas que saem de `code`: o que ele libera. */
  outgoing(code: string, relation?: EdgeRelation): GraphEdge[] {
    return (this.outOf.get(code) ?? []).filter((e) => !relation || e.relation === relation);
  }

  /** Ligações de pré-requisito entre componentes do próprio currículo (as que a tela do mapa consegue desenhar). */
  prerequisiteEdges(): { from: string; to: string; kind: EdgeStrength }[] {
    return this.edges
      .filter((e) => e.relation === 'PREREQUISITE' && this.components.has(e.from) && this.components.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, kind: e.strength }));
  }

  /** Códigos que `code` libera diretamente pelo pré-requisito (obrigatório ou alternativo). */
  unlocks(code: string): string[] {
    return this.outgoing(code, 'PREREQUISITE').map((e) => e.to);
  }
}

export const buildCurriculumGraph = (components: readonly CurriculumComponentInput[]): CurriculumGraph => new CurriculumGraph(components);
