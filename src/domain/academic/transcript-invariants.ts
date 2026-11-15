import { COMPLETED_STATUSES } from './progress';

/**
 * As contas que o PRÓPRIO documento permite sobre si mesmo. Uma leitura que errou uma coluna ainda produz um objeto
 * plausível; estas contas são a diferença entre uma falha visível e um dado errado calado na tela do aluno. Aqui elas
 * CLASSIFICAM (duras derrubam `verified`, brandas só avisam); o dado é entregue de qualquer forma.
 * Origem: `poc-historico/src/parsers/historico.ts` (`validarInvariantes`).
 */

export interface InvariantInput {
  components: readonly { term: string; hours: number; grade: number | null; status: string }[];
  hours: {
    mandatory: { completed: number };
    elective: { completed: number };
    complementary: { completed: number };
    total: { completed: number };
  };
  indices: { cr: number | null };
  pendingMandatory: { declaredTotal: number; items: readonly unknown[] };
}

export interface InvariantResult {
  /** Derrubam `verified`. */
  hard: string[];
  /** Só avisam. */
  soft: string[];
}

/** Reprovações por falta: a segunda leitura possível do CR as deixa de fora. */
const OUT_OF_CR = ['REPF', 'REPMF'];
const CR_TOLERANCE = 0.0001;

/** Média ponderada pela carga horária; nulo quando não há peso. */
function weightedCr(components: readonly { hours: number; grade: number | null }[]): number | null {
  const weight = components.reduce((sum, c) => sum + c.hours, 0);
  if (weight === 0) return null;
  return components.reduce((sum, c) => sum + c.hours * (c.grade as number), 0) / weight;
}

export function checkTranscriptInvariants(doc: InvariantInput): InvariantResult {
  const hard: string[] = [];
  const soft: string[] = [];

  const completedSum = doc.components.filter((c) => COMPLETED_STATUSES.includes(c.status)).reduce((sum, c) => sum + c.hours, 0);

  // Contra obrigatórias + optativas, não contra o total: as complementares (ACC: monitoria, estágio, eventos) são um bolo de
  // horas concedido sem componente, sem linha na tabela de onde a soma pudesse tirá-las (medido num histórico real:
  // obrigatórias 2040h, complementares 144h, total 2184h, e as linhas somando exatamente 2040h).
  const withRow = doc.hours.mandatory.completed + doc.hours.elective.completed;
  if (completedSum !== withRow) {
    const message =
      `Histórico inconsistente: a carga horária somada dos componentes concluídos (${completedSum}h) ` +
      `não bate com a integralizada em obrigatórias e optativas (${withRow}h).`;
    // Linhas sem semestre ("--") são aproveitamento de estudos, e o quadro do SIGAA parece contá-las com horas diferentes das
    // impressas na linha (observado num histórico real: 18h de diferença, CR e pendentes batendo): só aviso.
    if (doc.components.some((c) => c.term === '--')) soft.push(message);
    else hard.push(message);
  }

  // O total sai da comparação acima, então é checado aqui: sem esta linha o quadro deixaria de ser verificado por completo.
  const columnsSum = withRow + doc.hours.complementary.completed;
  if (columnsSum !== doc.hours.total.completed) {
    hard.push(
      `Histórico inconsistente: o total integralizado do quadro (${doc.hours.total.completed}h) não é a soma das suas colunas ` +
        `(obrigatórias ${doc.hours.mandatory.completed}h + optativas ${doc.hours.elective.completed}h + ` +
        `complementares ${doc.hours.complementary.completed}h = ${columnsSum}h).`,
    );
  }

  // CR ponderado pela carga horária sobre as linhas com nota; trancados e matriculados ficam fora do numerador e do
  // denominador (confirmado contra o documento real).
  const graded = doc.components.filter((c) => c.grade !== null);
  const totalWeight = graded.reduce((sum, c) => sum + c.hours, 0);
  const printedCr = doc.indices.cr;

  // CR nulo só é legítimo num histórico sem nada com nota. Com notas, o SIGAA sempre imprime um: nulo aqui quer dizer que o
  // rótulo mudou, e pular a checagem desligaria a evidência mais forte de que as células certas foram lidas.
  if (printedCr === null && totalWeight > 0) {
    hard.push('Histórico inconsistente: não achei o CR, mas existem componentes com nota. O layout do documento pode ter mudado.');
  }

  if (printedCr !== null && totalWeight > 0) {
    const withAll = weightedCr(graded);
    const withoutAbsence = weightedCr(graded.filter((c) => !OUT_OF_CR.includes(c.status)));
    // Terceira leitura (histórico real com aproveitamento): as linhas sem semestre ("--") ficam fora do CR do SIGAA.
    const withoutRecognition = weightedCr(graded.filter((c) => c.term !== '--'));
    // `Math.abs(NaN - x) > 0.0001` é falso: um candidato não finito (uma nota NaN) precisa ser excluído explicitamente, senão
    // passaria calado pela única invariante que existe para pegá-lo.
    const matches = (candidate: number | null): boolean =>
      candidate !== null && Number.isFinite(candidate) && Math.abs(candidate - printedCr) <= CR_TOLERANCE;

    if (!matches(withAll) && !matches(withoutAbsence) && !matches(withoutRecognition)) {
      hard.push(
        `Histórico inconsistente: o CR recalculado (${(withAll ?? NaN).toFixed(4)}` +
          `${withoutAbsence !== withAll ? `, ou ${(withoutAbsence ?? NaN).toFixed(4)} sem as reprovações por falta` : ''}` +
          `${withoutRecognition !== withAll ? `, ou ${(withoutRecognition ?? NaN).toFixed(4)} sem as linhas de aproveitamento` : ''}) ` +
          `não bate com o do documento (${printedCr}).`,
      );
    }
  }

  if (doc.pendingMandatory.items.length !== doc.pendingMandatory.declaredTotal) {
    hard.push(
      `Histórico inconsistente: li ${doc.pendingMandatory.items.length} componentes pendentes, mas o título declara ${doc.pendingMandatory.declaredTotal}.`,
    );
  }

  return { hard, soft };
}
