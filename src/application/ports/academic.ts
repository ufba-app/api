import type { TranscriptContract } from '../academic/transcript/contract';
import type { Secret } from '../shared/secret';

export type ImportStatus = 'RUNNING' | 'NEEDS_CONFIRMATION' | 'READY' | 'FAILED';

/** Por que a importação falhou. Só o código: nunca conteúdo do documento nem mensagem de erro de terceiros. */
export type ImportFailure =
  | 'REDACTION_REFUSED'
  | 'READER_FAILED'
  | 'SIGAA_UNAVAILABLE'
  | 'PDF_INVALID'
  | 'SESSION_EXPIRED'
  | 'TIMEOUT';

/** Perfil do portal do discente, lido na mesma sessão do PDF. */
export interface PortalProfile {
  registration: string | null;
  /** Como o portal escreve o curso: "ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador". */
  program: string | null;
  entryTerm: string | null;
}

export interface ImportState {
  userId: string;
  status: ImportStatus;
  failure: ImportFailure | null;
  /** Curso do catálogo (Program.sigaaId) a que este histórico pertence, quando deu para resolver. */
  programId: string | null;
  /** O contrato lido, à espera da confirmação (some ao confirmar, falhar ou vencer). */
  draft: TranscriptContract | null;
  profile: PortalProfile | null;
  verified: boolean | null;
  reader: string | null;
  componentsCount: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** Quando a pessoa confirmou e o histórico foi gravado. */
  importedAt: Date | null;
}

export interface ImportLogEntry {
  userId: string;
  startedAt: Date;
  result: string;
  verified: boolean | null;
  componentsCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

/** Estado e dados da vida acadêmica da pessoa. Nada aqui é identidade (nome, CPF, nascimento) nem o PDF. */
export abstract class AcademicRepository {
  abstract getConsent(userId: string): Promise<{ acceptedAt: Date; version: number } | null>;
  abstract saveConsent(userId: string, version: number, at: Date): Promise<void>;
  abstract deleteConsent(userId: string): Promise<void>;

  abstract getImport(userId: string): Promise<ImportState | null>;
  /** Cria ou troca o estado da importação (uma linha por pessoa). */
  abstract saveImport(state: ImportState): Promise<void>;
  abstract deleteImport(userId: string): Promise<void>;

  abstract addLog(entry: ImportLogEntry): Promise<void>;
  abstract countLogsSince(userId: string, since: Date): Promise<number>;
  /** Tokens gastos por todos desde `since` (base do teto mensal). */
  abstract usageSince(since: Date): Promise<{ inputTokens: number; outputTokens: number }>;

  /** Substitui por inteiro o histórico da pessoa pelo contrato confirmado. */
  abstract replaceTranscript(userId: string, contract: TranscriptContract): Promise<void>;
  abstract findTranscript(userId: string): Promise<TranscriptContract | null>;
  abstract deleteTranscript(userId: string): Promise<void>;

  abstract saveProfile(userId: string, profile: PortalProfile): Promise<void>;
  /** O perfil do portal gravado na confirmação (matrícula, curso, ingresso); `null` sem perfil. */
  abstract findProfile(userId: string): Promise<PortalProfile | null>;
  abstract clearProfile(userId: string): Promise<void>;
}

export interface TranscriptSnapshot {
  /** O PDF do histórico. Nunca é gravado. */
  pdf: Buffer;
  profile: PortalProfile;
}

/**
 * De onde vem o PDF do histórico: o SIGAA, pela sessão da pessoa (a senha só é usada se for preciso logar). Erros são
 * `SourceError` (REAUTH_NEEDED/CREDENTIAL_REJECTED: a senha não vale; o resto: SIGAA indisponível).
 */
export abstract class TranscriptSource {
  abstract fetch(credentials: { userId: string; login: string; password: Secret }): Promise<TranscriptSnapshot>;
}
