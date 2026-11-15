import type { CalendarContract, CalendarDocument } from '../calendar/contract';

export interface CalendarReadUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Token do leitor da IA: `null` sem `ANTHROPIC_API_KEY` (a leitura do calendário simplesmente não roda). */
export const CALENDAR_READER = Symbol('CALENDAR_READER');

/**
 * Lê o calendário acadêmico (PDF público, sem dado pessoal, então não há redação) e devolve o documento no contrato.
 * Com `pdf`, o leitor manda o próprio PDF ao modelo; `text` (extraído) serve às invariantes de qualquer forma.
 */
export abstract class CalendarReader {
  abstract read(text: string, pdf?: Buffer): Promise<{ document: CalendarDocument; usage?: CalendarReadUsage }>;
}

/** PDF → texto corrido (sem posição; o calendário é público e a conferência é por data impressa). */
export abstract class CalendarTextExtractor {
  abstract extract(pdf: Buffer): Promise<string>;
}

/** Um link de calendário na página da SUPAC: o texto do link é o semestre. */
export interface CalendarLink {
  term: string;
  url: string;
}

/** O que sai da página da SUPAC (rede). Falhas viram `SourceError`/`Error`; quem chama registra `ERROR`. */
export abstract class CalendarSource {
  /** Baixa a página e devolve os links de calendário (um por semestre/arquivo), do mais recente ao mais antigo. */
  abstract listLinks(): Promise<CalendarLink[]>;
  /** Baixa um PDF. 404 e afins lançam. */
  abstract download(url: string): Promise<Buffer>;
  /** URL da página (vai no log quando é a página que falha). */
  abstract pageUrl(): string;
}

export type CalendarLogStatus = 'PUBLISHED' | 'NOT_VERIFIED' | 'ERROR';

export interface CalendarLogRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  sourceUrl: string;
  sourceSha256: string | null;
  term: string | null;
  status: CalendarLogStatus;
  verified: boolean | null;
  warnings: string[];
  contract: CalendarContract | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  seen: boolean;
  seenBy: string | null;
  seenAt: Date | null;
}

export type NewCalendarLog = Omit<CalendarLogRow, 'id' | 'createdAt' | 'updatedAt' | 'seen' | 'seenBy' | 'seenAt'>;

export abstract class CalendarLogRepository {
  abstract findBySha(sha256: string): Promise<CalendarLogRow | null>;
  /** O ERROR mais recente desta URL sem hash (download que falhou), para atualizar em vez de duplicar. */
  abstract findErrorByUrl(url: string): Promise<CalendarLogRow | null>;
  abstract create(row: NewCalendarLog): Promise<CalendarLogRow>;
  /** Substitui o resultado (status, avisos, contrato, tokens, hash) mantendo id, `createdAt` e o "Visto". */
  abstract update(id: string, row: NewCalendarLog): Promise<CalendarLogRow>;
  abstract markSeen(id: string, userId: string, at: Date): Promise<CalendarLogRow | null>;
  /** Todos os logs não vistos que não são PUBLISHED (o filtro de semestre é da regra de alerta). */
  abstract listUnseenProblems(): Promise<CalendarLogRow[]>;
  /** Semestres com algum log (qualquer status), para saber de onde a leitura semanal olha. */
  abstract knownTerms(): Promise<string[]>;
  /** O PUBLISHED mais recente de cada semestre. */
  abstract listPublished(): Promise<CalendarLogRow[]>;
}
