import { Logger } from '@nestjs/common';
import { buildProgress, type Progress, type TranscriptInput } from '../../domain/academic/progress';
import { AcademicRepository, TranscriptSource, type ImportFailure, type ImportState, type ImportStatus } from '../ports/academic';
import type { CatalogComponent } from '../ports/catalog';
import type { Secret } from '../shared/secret';
import { PdfTextExtractor, TranscriptReader } from '../ports/transcript';
import { SourceError } from '../ports/source-gateway';
import type { ConnectionStatus } from '../web/connection-status';
import { ApiError, type WebPrincipal } from '../web/web-api';
import { CatalogService } from './catalog.service';
import { applyCurriculumCheck, readTranscript } from './transcript/read-transcript';
import type { TranscriptContract } from './transcript/contract';
import { RedactionFailed } from './transcript/redactor';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Versão do texto de consentimento: texto novo pede aceite novo. */
export const CONSENT_VERSION = 1;
export const DAILY_LIMIT = 3;
/** Uma importação "rodando" há mais que isto morreu (o processo reiniciou): vira falha, e a pessoa pode tentar de novo. */
export const STALE_RUNNING_MS = 10 * MINUTE_MS;
/** O rascunho à espera de confirmação vale 7 dias. */
export const DRAFT_TTL_MS = 7 * DAY_MS;
/** Preço do Haiku 5.5 por token (US$ 0,10 por milhão de entrada, US$ 0,50 por milhão de saída). */
const PRICE_IN = 0.1 / 1_000_000;
const PRICE_OUT = 0.5 / 1_000_000;
/** Depois de uma falha, só tenta de novo a grade do curso passado este tempo (não martela o SIGAA a cada consulta). */
const CATALOG_RETRY_MS = 10 * MINUTE_MS;

export type CurriculumStatus = 'NONE' | 'READY' | 'IMPORTING' | 'UNAVAILABLE';

export interface AcademicSummary {
  programName: string;
  curriculum: string;
  currentTerm: number;
  completionDeadline: { standard: string; maximum: string };
  indices: { cr: number | null; iap: number | null };
  hours: TranscriptContract['hours'];
}

export interface AcademicState {
  /** A leitura está disponível neste servidor (há chave do provedor configurada). */
  available: boolean;
  consent: boolean;
  status: 'NONE' | ImportStatus;
  failure: ImportFailure | null;
  verified: boolean | null;
  reader: string | null;
  importedAt: Date | null;
  curriculumStatus: CurriculumStatus;
  summary: AcademicSummary | null;
  /** O que foi lido, à espera da confirmação. Só em `NEEDS_CONFIRMATION`. */
  draft: TranscriptContract | null;
}

/** Falha de uma etapa, com o código que vai para o estado. Nunca carrega conteúdo do documento. */
class StepFailure extends Error {
  constructor(readonly code: ImportFailure) {
    super(code);
  }
}

const unavailable = () => new ApiError(503, 'import_unavailable', 'A importação do histórico está indisponível no momento. Tente mais tarde.');

/** O quadro do contrato → o que o domínio precisa para adequar o histórico ao currículo Ativo. */
export function toProgressInput(t: TranscriptContract): TranscriptInput {
  return {
    entries: t.components.map((c) => ({ term: c.term, nature: c.kind, code: c.code, name: c.name, hours: c.hours, grade: c.grade, status: c.status })),
    pending: t.pendingMandatory.items,
    hours: t.hours,
    equivalences: t.equivalences,
    currentTerm: t.program.currentTerm,
    curriculumCode: t.program.curriculum,
  };
}

/**
 * Importação da vida acadêmica (docs/specs/2026-11-15-vida-academica.md §4 a §6): consentimento, leitura do histórico em
 * segundo plano (a IA só LÊ), confirmação da pessoa antes de gravar, e a adequação ao currículo Ativo do curso.
 *
 * O PDF nunca é gravado; o texto enviado ao provedor (já sem identidade) nem a resposta dele também não: só o contrato lido
 * (que a pessoa confirma), contagens e o aceite. Logs só têm contagens. Premissa: a API roda em UMA instância (o trabalho em
 * segundo plano e a trava de "rodando" vivem em memória; um processo que morre no meio deixa uma importação "rodando" que
 * vence sozinha em 10 minutos).
 */
/**
 * Há histórico gravado? `READY` sim; nos outros estados (lendo, rascunho, falha de um Atualizar) o `importedAt` carrega a data do
 * histórico que continua valendo (é nulo quando a pessoa nunca confirmou nada).
 */
function hasStoredHistory(imp: ImportState | null): boolean {
  return imp?.status === 'READY' || (imp?.importedAt ?? null) !== null;
}

export class AcademicImports {
  private readonly log = new Logger('AcademicImports');
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly catalogRetry = new Map<string, number>();

  constructor(
    private readonly repo: AcademicRepository,
    private readonly source: TranscriptSource,
    private readonly extractor: PdfTextExtractor,
    /** `null` sem `ANTHROPIC_API_KEY`: a importação simplesmente não existe. */
    private readonly reader: TranscriptReader | null,
    private readonly catalog: CatalogService,
    private readonly sigaa: Pick<ConnectionStatus, 'openSigaa'>,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: { monthlyCapUsd: number } = { monthlyCapUsd: 5 },
  ) {}

  available(): boolean {
    return this.reader !== null;
  }

  async setConsent(p: WebPrincipal, accepted: boolean): Promise<void> {
    if (accepted) await this.repo.saveConsent(p.userId, CONSENT_VERSION, this.now());
    else await this.repo.deleteConsent(p.userId);
  }

  async state(p: WebPrincipal): Promise<AcademicState> {
    const consent = await this.hasConsent(p.userId);
    const imp = await this.freshImport(p.userId);
    // O histórico gravado aparece em qualquer status (inclusive durante um Atualizar); `importedAt` é o dele.
    const transcript = hasStoredHistory(imp) ? await this.repo.findTranscript(p.userId) : null;
    return {
      available: this.available(),
      consent,
      status: imp?.status ?? 'NONE',
      failure: imp?.failure ?? null,
      verified: imp?.verified ?? null,
      reader: imp?.reader ?? null,
      importedAt: imp?.importedAt ?? null,
      curriculumStatus: await this.curriculumStatus(imp),
      summary: transcript
        ? {
            programName: transcript.program.name,
            curriculum: transcript.program.curriculum,
            currentTerm: transcript.program.currentTerm,
            completionDeadline: transcript.program.completionDeadline,
            indices: transcript.indices,
            hours: transcript.hours,
          }
        : null,
      draft: imp?.status === 'NEEDS_CONFIRMATION' ? imp.draft : null,
    };
  }

  /** Dispara a importação em segundo plano. Devolve assim que o trabalho foi agendado (a tela acompanha pelo estado). */
  async start(p: WebPrincipal): Promise<void> {
    if (!this.reader) throw unavailable();
    if (!(await this.hasConsent(p.userId))) {
      throw new ApiError(409, 'consent_required', 'Aceite o envio das disciplinas e notas ao provedor de IA antes de importar o histórico.');
    }
    const cred = await this.sigaa.openSigaa(p);
    if (!cred) throw new ApiError(409, 'source_not_connected', 'Conecte ou desbloqueie o SIGAA nesta sessão antes de importar o histórico.');

    const current = await this.freshImport(p.userId);
    if (current?.status === 'RUNNING' || this.inflight.has(p.userId)) {
      throw new ApiError(409, 'import_in_progress', 'Já existe uma importação em andamento.');
    }
    if ((await this.repo.countLogsSince(p.userId, new Date(this.now().getTime() - DAY_MS))) >= DAILY_LIMIT) {
      throw new ApiError(429, 'too_many_attempts', `Você já tentou ${DAILY_LIMIT} vezes hoje. Tente amanhã.`);
    }
    if (await this.overMonthlyCap()) throw unavailable();

    const startedAt = this.now();
    // Atualizar com um histórico já gravado: ele continua valendo (data e curso) enquanto a nova leitura roda ou falha.
    const carry = hasStoredHistory(current) ? { programId: current!.programId, importedAt: current!.importedAt } : null;
    await this.repo.saveImport({
      userId: p.userId,
      status: 'RUNNING',
      failure: null,
      programId: carry?.programId ?? null,
      draft: null,
      profile: null,
      verified: null,
      reader: null,
      componentsCount: null,
      startedAt,
      finishedAt: null,
      importedAt: carry?.importedAt ?? null,
    });
    const job = this.run(p.userId, cred.login, cred.senha, startedAt, carry).finally(() => this.inflight.delete(p.userId));
    this.inflight.set(p.userId, job);
  }

  /** Espera o trabalho em segundo plano da pessoa terminar (testes e desligamento ordenado). */
  async idle(userId: string): Promise<void> {
    await this.inflight.get(userId);
  }

  /** A pessoa conferiu o que foi lido: grava o histórico (substitui o anterior) e o perfil, e apaga o rascunho. */
  async confirm(p: WebPrincipal): Promise<void> {
    const imp = await this.freshImport(p.userId);
    if (!imp || imp.status !== 'NEEDS_CONFIRMATION' || !imp.draft) {
      throw new ApiError(404, 'import_not_found', 'Não há nenhuma leitura esperando confirmação. Importe o histórico de novo.');
    }
    await this.repo.replaceTranscript(p.userId, imp.draft);
    if (imp.profile) await this.repo.saveProfile(p.userId, imp.profile);
    await this.repo.saveImport({ ...imp, status: 'READY', draft: null, importedAt: this.now() });
  }

  /**
   * Descarta SÓ o rascunho (ou a falha) de um Atualizar, sem mexer no histórico gravado: com histórico, o estado volta a
   * `READY`; sem, a `NONE`. Durante a leitura não dá (409); sem rascunho nem falha, 404.
   */
  async discardDraft(p: WebPrincipal): Promise<void> {
    const imp = await this.freshImport(p.userId);
    if (imp?.status === 'RUNNING' || this.inflight.has(p.userId)) {
      throw new ApiError(409, 'import_in_progress', 'Já existe uma importação em andamento.');
    }
    if (!imp || (imp.status !== 'NEEDS_CONFIRMATION' && imp.status !== 'FAILED')) {
      throw new ApiError(404, 'import_not_found', 'Não há rascunho nem falha de importação para descartar.');
    }
    await this.dropDraft(imp);
  }

  /** Tira o rascunho/falha: volta ao histórico gravado (`READY`) se há, senão apaga o estado (`NONE`). */
  private async dropDraft(imp: ImportState): Promise<ImportState | null> {
    const stored = hasStoredHistory(imp) ? await this.repo.findTranscript(imp.userId) : null;
    if (!stored) {
      await this.repo.deleteImport(imp.userId);
      return null;
    }
    const ready: ImportState = {
      ...imp,
      status: 'READY',
      failure: null,
      draft: null,
      profile: null,
      verified: stored.verification.verified,
      reader: stored.verification.reader,
      componentsCount: stored.components.length,
      finishedAt: this.now(),
    };
    await this.repo.saveImport(ready);
    return ready;
  }

  /** Apaga o histórico, o rascunho e o perfil importado. O aceite fica (a pessoa revoga à parte). */
  async remove(p: WebPrincipal): Promise<void> {
    await this.repo.deleteTranscript(p.userId);
    await this.repo.deleteImport(p.userId);
    await this.repo.clearProfile(p.userId);
  }

  /** A grade do curso (currículo Ativo) marcada com o que a pessoa já fez. Sempre uma ESTIMATIVA. */
  async progress(p: WebPrincipal): Promise<Progress> {
    const transcript = await this.repo.findTranscript(p.userId);
    if (!transcript) throw new ApiError(404, 'import_not_found', 'Importe o histórico antes de ver a grade do curso.');
    const imp = await this.repo.getImport(p.userId);
    const stored = imp?.programId ? await this.catalog.read(imp.programId) : null;
    if (!stored) throw new ApiError(409, 'curriculum_unavailable', 'A grade do seu curso ainda não está disponível.');
    return buildProgress(toProgressInput(transcript), { ...stored.curriculum, components: stored.components });
  }

  // ---- trabalho em segundo plano ----

  private async run(
    userId: string,
    login: string,
    password: Secret,
    startedAt: Date,
    carry: { programId: string | null; importedAt: Date | null } | null,
  ): Promise<void> {
    const began = Date.now();
    let result = 'OK';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let verified: boolean | null = null;
    let componentsCount: number | null = null;
    try {
      const snapshot = await this.fetchSnapshot(userId, login, password);
      let items;
      try {
        items = await this.extractor.extract(snapshot.pdf);
      } catch {
        throw new StepFailure('PDF_INVALID');
      }

      // O curso começa já (o nome vem do portal, sem esperar o histórico) e roda em paralelo com a leitura da IA.
      const early = snapshot.profile.program ? this.catalogFor(snapshot.profile.program) : null;
      let read;
      try {
        read = await readTranscript(items, this.reader as TranscriptReader);
      } catch (e) {
        throw new StepFailure(e instanceof RedactionFailed ? 'REDACTION_REFUSED' : 'READER_FAILED');
      }
      usage = read.usage;
      const cat = (early ? await early : null) ?? (await this.catalogFor(read.contract.program.name));
      const contract = cat?.components ? applyCurriculumCheck(read.contract, cat.components) : read.contract;
      verified = contract.verification.verified;
      componentsCount = contract.components.length;
      result = 'NEEDS_CONFIRMATION';

      await this.repo.saveImport({
        userId,
        status: 'NEEDS_CONFIRMATION',
        failure: null,
        programId: cat?.programId ?? null,
        draft: contract,
        profile: snapshot.profile,
        verified,
        reader: contract.verification.reader,
        componentsCount,
        startedAt,
        finishedAt: this.now(),
        importedAt: carry?.importedAt ?? null,
      });
    } catch (e) {
      const failure: ImportFailure = e instanceof StepFailure ? e.code : 'SIGAA_UNAVAILABLE';
      result = failure;
      // Só o código: nunca a mensagem (pode ecoar conteúdo do documento ou da fonte).
      this.log.warn(`importação do histórico falhou: ${failure}`);
      await this.repo.saveImport({
        userId,
        status: 'FAILED',
        failure,
        programId: carry?.programId ?? null,
        draft: null,
        profile: null,
        verified: null,
        reader: null,
        componentsCount: null,
        startedAt,
        finishedAt: this.now(),
        importedAt: carry?.importedAt ?? null,
      });
    } finally {
      const latencyMs = Date.now() - began;
      await this.repo
        .addLog({
          userId,
          startedAt,
          result,
          verified,
          componentsCount,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          latencyMs,
        })
        .catch(() => undefined);
      this.log.log(`importação do histórico: ${result}, ${componentsCount ?? 0} componentes, ${latencyMs} ms, ${usage?.inputTokens ?? 0}+${usage?.outputTokens ?? 0} tokens`);
    }
  }

  private async fetchSnapshot(userId: string, login: string, password: Secret) {
    try {
      return await this.source.fetch({ userId, login, password });
    } catch (e) {
      // A senha não vale (ou a sessão expirou): a pessoa precisa digitar de novo. Qualquer outra falha: SIGAA indisponível.
      if (e instanceof SourceError && (e.code === 'REAUTH_NEEDED' || e.code === 'CREDENTIAL_REJECTED')) throw new StepFailure('SESSION_EXPIRED');
      throw new StepFailure('SIGAA_UNAVAILABLE');
    }
  }

  /** O curso no catálogo (importa se faltar). NUNCA lança: a grade do curso é um bônus, o histórico vale sem ela. */
  private async catalogFor(programName: string): Promise<{ programId: string; components: CatalogComponent[] | null } | null> {
    try {
      const program = await this.catalog.findProgram(programName);
      try {
        await this.catalog.ensureCurriculum(program.sigaaId);
        const stored = await this.catalog.read(program.sigaaId);
        return { programId: program.sigaaId, components: stored?.components ?? null };
      } catch {
        return { programId: program.sigaaId, components: null };
      }
    } catch {
      return null;
    }
  }

  // ---- estado ----

  private async hasConsent(userId: string): Promise<boolean> {
    const c = await this.repo.getConsent(userId);
    return !!c && c.version >= CONSENT_VERSION;
  }

  /** O estado atual, já com o que venceu resolvido: "rodando" parado há 10 min falha; rascunho com 7 dias some. */
  private async freshImport(userId: string): Promise<ImportState | null> {
    const imp = await this.repo.getImport(userId);
    if (!imp) return null;
    const age = this.now().getTime() - imp.startedAt.getTime();
    if (imp.status === 'RUNNING' && age > STALE_RUNNING_MS && !this.inflight.has(userId)) {
      const failed: ImportState = { ...imp, status: 'FAILED', failure: 'TIMEOUT', finishedAt: this.now() };
      await this.repo.saveImport(failed);
      return failed;
    }
    if (imp.status === 'NEEDS_CONFIRMATION' && imp.finishedAt && this.now().getTime() - imp.finishedAt.getTime() > DRAFT_TTL_MS) {
      return this.dropDraft(imp);
    }
    return imp;
  }

  private async curriculumStatus(imp: ImportState | null): Promise<CurriculumStatus> {
    if (!imp || !imp.programId || (imp.status !== 'READY' && imp.status !== 'NEEDS_CONFIRMATION' && !hasStoredHistory(imp))) return 'NONE';
    if (await this.catalog.read(imp.programId)) return 'READY';
    if (this.catalog.importing(imp.programId)) return 'IMPORTING';
    // A grade não está lá e ninguém a está buscando: tenta de novo em segundo plano (com intervalo, sem martelar o SIGAA).
    const last = this.catalogRetry.get(imp.programId) ?? 0;
    if (this.now().getTime() - last > CATALOG_RETRY_MS) {
      this.catalogRetry.set(imp.programId, this.now().getTime());
      void this.catalog.ensureCurriculum(imp.programId).catch(() => undefined);
      return 'IMPORTING';
    }
    return 'UNAVAILABLE';
  }

  private async overMonthlyCap(): Promise<boolean> {
    const now = this.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const used = await this.repo.usageSince(monthStart);
    return used.inputTokens * PRICE_IN + used.outputTokens * PRICE_OUT >= this.opts.monthlyCapUsd;
  }
}

