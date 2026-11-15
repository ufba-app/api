import { Logger } from '@nestjs/common';
import { labelShape, parseProgramLabel, type ProgramLabel } from '../../domain/academic/program-label';

const log = new Logger('ProgramLabel');
/** Formatos fora do padrão já avisados neste processo (uma linha por formato, não por consulta). */
const warned = new Set<string>();

/**
 * Separa o texto do curso para a tela (`parseProgramLabel`) e avisa UMA vez por processo quando o formato fugiu do
 * padrão completo, para a equipe descobrir o que a UFBA realmente manda. O aviso leva só o FORMATO (degrau, número de
 * pedaços e quais valores não são conhecidos), nunca o texto do curso nem de quem é.
 */
export function programLabelFor(raw: string): ProgramLabel {
  const label = parseProgramLabel(raw);
  const shape = labelShape(raw, label);
  if (shape !== 'full:5p' && !warned.has(shape)) {
    warned.add(shape);
    log.warn(`formato do nome do curso fora do padrão: ${shape}`);
  }
  return label;
}

/** Só para os testes. */
export const resetProgramLabelWarnings = () => warned.clear();
