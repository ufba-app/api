import { createHash } from 'node:crypto';
import {
  CalendarLogRepository,
  CalendarReader,
  CalendarSource,
  CalendarTextExtractor,
  type CalendarLink,
  type CalendarLogRow,
  type NewCalendarLog,
} from '../ports/calendar';
import type { CalendarContract } from './contract';
import { ApiError } from '../web/web-api';
import { readCalendar } from './read-calendar';

/** Modelo registrado no log (o leitor da Anthropic usa este mesmo, fixo). */
export const CALENDAR_MODEL = 'claude-haiku-5-5';

/** Um ERROR só é tentado de novo depois disto (a leitura roda no boot e toda semana; deploy não pode gerar chamada). */
export const ERROR_RETRY_AFTER_MS = 6 * 24 * 60 * 60_000;

export interface WatchSummary {
  /** `false` quando a leitura não existe (sem chave da IA) ou já havia uma rodando. */
  ran: boolean;
  considered: number;
  published: number;
  notVerified: number;
  errors: number;
  skipped: number;
}

const TERM = /^\d{4}\.[12]$/;

type Usage = { inputTokens: number | null; outputTokens: number | null };

/** Só mensagens que o nosso próprio código produz (status HTTP, schema, limite de tokens). Nunca o corpo de uma resposta. */
function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : 'erro desconhecido';
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Leitura semanal do calendário acadêmico (handoffs/calendario-cron-e-alerta-admin.md).
 *
 *  - Página da SUPAC → links; olha só do semestre mais novo já conhecido em diante (na primeira vez, só o mais recente).
 *  - Mesmo arquivo (SHA-256) não é lido duas vezes; arquivo novo ou trocado é lido.
 *  - `verified` publica; `!verified` registra NOT_VERIFIED e não publica; falha de execução registra ERROR.
 *  - Antes de registrar NOT_VERIFIED ou ERROR, relê UMA vez (a leitura da IA oscila; ~1 centavo): exceção explícita à
 *    regra de idempotência, que vale só dentro da mesma execução.
 */
export class CalendarWatcher {
  private running = false;
  private readonly reprocessing = new Map<string, Promise<void>>();

  constructor(
    private readonly logs: CalendarLogRepository,
    private readonly source: CalendarSource,
    private readonly extractor: CalendarTextExtractor,
    /** `null` sem `ANTHROPIC_API_KEY`: não há o que rodar. */
    private readonly reader: CalendarReader | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  available(): boolean {
    return this.reader !== null;
  }

  async run(): Promise<WatchSummary> {
    const summary: WatchSummary = { ran: false, considered: 0, published: 0, notVerified: 0, errors: 0, skipped: 0 };
    if (!this.reader || this.running) return summary;
    this.running = true;
    summary.ran = true;
    try {
      let links: CalendarLink[];
      try {
        links = await this.source.listLinks();
      } catch (e) {
        await this.recordFailure(this.source.pageUrl(), null, `Não foi possível ler a página da SUPAC: ${reason(e)}`, summary);
        return summary;
      }
      if (links.length === 0) {
        await this.recordFailure(this.source.pageUrl(), null, 'A página da SUPAC não tem links de calendário (o HTML pode ter mudado).', summary);
        return summary;
      }
      const known = (await this.logs.knownTerms()).filter((t) => TERM.test(t)).sort();
      const floor = known.at(-1) ?? links[0]!.term; // links já vêm do mais novo ao mais antigo
      for (const link of links.filter((l) => l.term >= floor)) {
        summary.considered += 1;
        try {
          await this.handle(link, summary);
        } catch {
          // Falha de banco num link não derruba os outros.
          summary.errors += 1;
        }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private recent(row: CalendarLogRow): boolean {
    return this.now().getTime() - row.updatedAt.getTime() < ERROR_RETRY_AFTER_MS;
  }

  private async handle(link: CalendarLink, summary: WatchSummary): Promise<void> {
    let pdf: Buffer;
    try {
      pdf = await this.source.download(link.url);
    } catch (e) {
      const previous = await this.logs.findErrorByUrl(link.url);
      if (previous && this.recent(previous)) {
        summary.skipped += 1;
        return;
      }
      await this.recordFailure(link.url, link.term, `Falha ao baixar o PDF: ${reason(e)}`, summary);
      return;
    }

    const sha = createHash('sha256').update(pdf).digest('hex');
    const existing = await this.logs.findBySha(sha);
    if (existing && (existing.status !== 'ERROR' || this.recent(existing))) {
      summary.skipped += 1;
      return;
    }

    const { row, kind } = await this.buildRow(link, pdf, sha);
    if (kind === 'error') summary.errors += 1;
    else if (kind === 'published') summary.published += 1;
    else summary.notVerified += 1;
    // ERROR anterior do mesmo arquivo, ou do download que falhava nesta URL: a linha é atualizada (mantém o "Visto").
    const old = existing ?? (await this.logs.findErrorByUrl(link.url));
    if (old) await this.logs.update(old.id, row);
    else await this.logs.create(row);
  }

  /** Lê o PDF (com a releitura única) e monta a linha do log: PUBLISHED, NOT_VERIFIED ou ERROR. */
  private async buildRow(
    link: { term: string | null; url: string },
    pdf: Buffer,
    sha: string,
  ): Promise<{ row: NewCalendarLog; kind: 'published' | 'notVerified' | 'error' }> {
    const outcome = await this.readTwice(pdf);
    const base = { sourceUrl: link.url, sourceSha256: sha, model: CALENDAR_MODEL };
    if (outcome.kind === 'error') {
      return {
        kind: 'error',
        row: { ...base, term: link.term, status: 'ERROR', verified: null, warnings: [outcome.message], contract: null, ...outcome.usage },
      };
    }
    const c = outcome.contract;
    // O semestre do documento vale mais que o do texto do link.
    const term = TERM.test(c.document.term) ? c.document.term : link.term;
    const verified = c.verification.verified;
    return {
      kind: verified ? 'published' : 'notVerified',
      row: { ...base, term, status: verified ? 'PUBLISHED' : 'NOT_VERIFIED', verified, warnings: c.verification.warnings, contract: c, ...outcome.usage },
    };
  }

  /**
   * "Reprocessar" (botão na linha do alerta): lê de novo o MESMO arquivo e atualiza a MESMA linha (mantém Visto/quem/quando).
   * Valida na hora (404, 409, 503) e roda em segundo plano: a leitura leva até alguns minutos (duas tentativas). A tela
   * acompanha pela lista de alertas. Ignora a idempotência por hash, de propósito. Só NOT_VERIFIED e ERROR de um PDF.
   */
  async startReprocess(id: string): Promise<void> {
    if (!this.reader) throw new ApiError(503, 'calendar_unavailable', 'A leitura do calendário está indisponível neste servidor.');
    const row = await this.logs.findById(id);
    if (!row) throw new ApiError(404, 'not_found', 'Registro não encontrado.');
    if (row.status === 'PUBLISHED') {
      throw new ApiError(409, 'calendar_log_not_reprocessable', 'Esta leitura já foi publicada; só leituras não verificadas ou com erro podem ser reprocessadas.');
    }
    if (row.sourceUrl === this.source.pageUrl()) {
      throw new ApiError(409, 'calendar_log_not_reprocessable', 'Este alerta é da página inteira, não de um arquivo. A próxima leitura semanal o refaz.');
    }
    if (this.reprocessing.has(id)) throw new ApiError(409, 'calendar_log_not_reprocessable', 'Este registro já está sendo reprocessado.');
    const job = this.reprocessOnce(row).finally(() => this.reprocessing.delete(id));
    this.reprocessing.set(id, job);
    job.catch(() => undefined);
  }

  /** Espera o reprocessamento do registro terminar (testes e desligamento ordenado). */
  async idle(id: string): Promise<void> {
    await this.reprocessing.get(id)?.catch(() => undefined);
  }

  private async reprocessOnce(row: CalendarLogRow): Promise<void> {
    const fail = (message: string): NewCalendarLog => ({
      sourceUrl: row.sourceUrl,
      sourceSha256: row.sourceSha256,
      term: row.term,
      status: 'ERROR',
      verified: null,
      warnings: [message],
      contract: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    });
    let pdf: Buffer;
    try {
      pdf = await this.source.download(row.sourceUrl);
    } catch (e) {
      await this.logs.update(row.id, fail(`Falha ao baixar o PDF: ${reason(e)}`));
      return;
    }
    const sha = createHash('sha256').update(pdf).digest('hex');
    const other = await this.logs.findBySha(sha);
    if (other && other.id !== row.id) {
      await this.logs.update(row.id, fail('Este arquivo já foi lido em outro registro do log.'));
      return;
    }
    await this.logs.update(row.id, (await this.buildRow({ term: row.term, url: row.sourceUrl }, pdf, sha)).row);
  }

  /** Lê; se não fechar (ou falhar), lê mais uma vez. Soma os tokens das duas. */
  private async readTwice(
    pdf: Buffer,
  ): Promise<{ kind: 'ok'; contract: CalendarContract; usage: Usage } | { kind: 'error'; message: string; usage: Usage }> {
    let text: string;
    try {
      text = await this.extractor.extract(pdf);
    } catch (e) {
      return { kind: 'error', message: `Não foi possível extrair o texto do PDF: ${reason(e)}`, usage: { inputTokens: null, outputTokens: null } };
    }
    let input = 0;
    let output = 0;
    let counted = false;
    let best: CalendarContract | null = null;
    let message = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { usage, ...contract } = await readCalendar(text, this.reader!, pdf);
        if (usage) {
          input += usage.inputTokens;
          output += usage.outputTokens;
          counted = true;
        }
        best = contract;
        if (contract.verification.verified) break;
      } catch (e) {
        message = `Falha na leitura pela IA: ${reason(e)}`;
      }
    }
    const usage = { inputTokens: counted ? input : null, outputTokens: counted ? output : null };
    return best ? { kind: 'ok', contract: best, usage } : { kind: 'error', message, usage };
  }

  /** ERROR sem arquivo: atualiza o ERROR anterior desta URL (sem repetir a linha toda semana) ou cria. */
  private async recordFailure(url: string, term: string | null, message: string, summary: WatchSummary): Promise<void> {
    summary.errors += 1;
    const row: NewCalendarLog = {
      sourceUrl: url,
      sourceSha256: null,
      term,
      status: 'ERROR',
      verified: null,
      warnings: [message],
      contract: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    };
    const previous = await this.logs.findErrorByUrl(url);
    if (previous) await this.logs.update(previous.id, row);
    else await this.logs.create(row);
  }
}
