import { crossCheckTranscript, type CurriculumComponentInput } from '../../../domain/academic/progress';
import { checkTranscriptInvariants } from '../../../domain/academic/transcript-invariants';
import type { TextItem, TranscriptReadUsage, TranscriptReader } from '../../ports/transcript';
import { KIND_CODES, STATUS_CODES, type TranscriptContract, type TranscriptDocument } from './contract';
import { redactDocument, type RedactedDocument } from './redactor';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Acima desta fração dos obrigatórios (OB) lidos fora do curso (e fora de qualquer equivalência), a leitura é suspeita. */
const UNKNOWN_REQUIRED_LIMIT = 0.25;
const UNKNOWN_REQUIRED_MIN = 3;

export interface ReadTranscriptResult {
  /** O JSON que a leitura entrega. `verification.verified` diz se a aritmética (e o curso) fecharam. */
  contract: TranscriptContract;
  /** Só contagens, nunca conteúdo. */
  redaction: Pick<RedactedDocument, 'keptLines' | 'droppedLines'>;
  usage?: TranscriptReadUsage;
}

/**
 * Conferência de cada linha lida contra o curso (código e horas), sem rede e sem IA (docs/specs/2026-11-15-vida-academica.md
 * §4.3). Obrigatório que não existe no curso nem em equivalência pode ser currículo antigo ou leitura errada: aviso; mas
 * muitos deles (a partir de 3 e mais de 25% dos obrigatórios) tornam a leitura suspeita.
 */
export function curriculumCheck(
  document: Pick<TranscriptDocument, 'components'>,
  curriculumComponents: readonly CurriculumComponentInput[],
): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  const check = crossCheckTranscript(
    document.components.map((c) => ({ ...c, nature: c.kind })),
    curriculumComponents,
  );
  const required = document.components.filter((c) => c.kind === 'OB').length;
  if (check.unknownRequired.length > 0) {
    const message = `${check.unknownRequired.length} componente(s) obrigatório(s) do histórico não existem no currículo do curso nem em equivalência dele: ${check.unknownRequired.join(', ')}. Pode ser um currículo antigo ou uma leitura errada.`;
    if (check.unknownRequired.length >= UNKNOWN_REQUIRED_MIN && check.unknownRequired.length > required * UNKNOWN_REQUIRED_LIMIT) hard.push(message);
    else soft.push(message);
  }
  if (check.hourMismatches.length > 0) {
    soft.push(
      `Carga horária diferente da do curso em: ${check.hourMismatches.map((m) => `${m.code} (${m.document}h no histórico, ${m.catalog}h no curso)`).join('; ')}.`,
    );
  }
  return { hard, soft };
}

/**
 * Aplica a conferência com o curso a uma leitura que já saiu SEM ela (o catálogo ficou pronto depois da leitura, porque a
 * importação do curso roda em paralelo). Só acrescenta avisos e, se for o caso, derruba `verified`.
 */
export function applyCurriculumCheck(contract: TranscriptContract, curriculumComponents: readonly CurriculumComponentInput[]): TranscriptContract {
  if (curriculumComponents.length === 0) return contract;
  const { hard, soft } = curriculumCheck(contract, curriculumComponents);
  if (hard.length === 0 && soft.length === 0) return contract;
  return {
    ...contract,
    verification: {
      ...contract.verification,
      verified: contract.verification.verified && hard.length === 0,
      warnings: [...contract.verification.warnings, ...hard, ...soft],
    },
  };
}

/**
 * A IA lê o documento inteiro; o determinismo fica na redação (antes) e nas invariantes (depois). Só LANÇA em dois casos:
 * a redação se recusa a enviar (`RedactionFailed`) ou a chamada ao modelo falha: nesses casos não existe leitura para
 * entregar. Uma leitura que não fecha a aritmética é entregue com `verified: false` e os motivos.
 *
 * Com o catálogo do curso já importado (`curriculumComponents`), cada linha lida também é conferida contra o curso. Sem ele,
 * a conferência é pulada (e pode ser aplicada depois com `applyCurriculumCheck`).
 */
export async function readTranscript(
  items: TextItem[],
  reader: TranscriptReader,
  options: { curriculumComponents?: readonly CurriculumComponentInput[] } = {},
): Promise<ReadTranscriptResult> {
  const redacted = redactDocument(items);
  const { document, usage } = await reader.read(redacted.text);

  const { hard, soft } = checkTranscriptInvariants(document);
  if (!ISO_DATE.test(document.document.issuedOn)) {
    hard.push(`Data de emissão fora do formato AAAA-MM-DD: "${document.document.issuedOn}".`);
  }

  // Sigla fora da legenda: AVISO (a linha segue). Fechar o enum faria o modelo escolher uma sigla errada.
  const unknownStatus = [...new Set(document.components.map((c) => c.status).filter((s) => !(STATUS_CODES as readonly string[]).includes(s)))];
  const unknownKind = [...new Set(document.components.map((c) => c.kind).filter((k): k is string => k !== null && !(KIND_CODES as readonly string[]).includes(k)))];
  if (unknownStatus.length) soft.push(`Situação fora da legenda conhecida: ${unknownStatus.join(', ')}. Essas linhas não contam como cumpridas.`);
  if (unknownKind.length) soft.push(`Natureza fora da legenda conhecida: ${unknownKind.join(', ')}.`);

  if (options.curriculumComponents?.length) {
    const check = curriculumCheck(document, options.curriculumComponents);
    hard.push(...check.hard);
    soft.push(...check.soft);
  }

  return {
    contract: {
      contractVersion: '1',
      document: document.document,
      program: document.program,
      indices: document.indices,
      components: document.components,
      hours: document.hours,
      pendingMandatory: document.pendingMandatory,
      equivalences: document.equivalences,
      notes: document.notes,
      verification: { verified: hard.length === 0, warnings: [...hard, ...soft], reader: 'ai' },
    },
    redaction: { keptLines: redacted.keptLines, droppedLines: redacted.droppedLines },
    ...(usage ? { usage } : {}),
  };
}
