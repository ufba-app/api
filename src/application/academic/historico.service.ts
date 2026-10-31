import { Inject, Injectable } from '@nestjs/common';
import {
  transcriptInsights,
  type TranscriptData,
  type TranscriptInsights,
} from '../../domain/academic';
import { HISTORY_EXTRACTOR, type HistoryExtractor } from '../ports/history-extractor';
import { ReadRepository } from '../ports/repositories';
import { TranscriptRepository, TranscriptSource } from '../ports/academic-ports';
import type { Lido } from '../read/leitura.service';
import { importTranscript, type ImportedTranscript } from './import-transcript';

export type InsightTipo = 'cr' | 'trajetoria' | 'pendentes';

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Reconstrói `TranscriptData` a partir do que o banco devolve (Decimal vira string/objeto, datas viram Date).
 * Tolerante: campos ausentes viram vazio, para que um insight nunca derrube a leitura.
 */
export function toTranscriptData(raw: unknown): TranscriptData {
  const r = (raw ?? {}) as Record<string, unknown>;
  const entries = (Array.isArray(r.entries) ? r.entries : []) as Array<Record<string, unknown>>;
  const pending = (Array.isArray(r.pending) ? r.pending : []) as Array<Record<string, unknown>>;
  const issued = r.issuedAt instanceof Date ? r.issuedAt.toISOString().slice(0, 10) : String(r.issuedAt ?? '');
  return {
    issuedAt: issued,
    curriculumCode: String(r.curriculumCode ?? ''),
    programName: String(r.programName ?? ''),
    currentTerm: Number(r.currentTerm ?? 0),
    standardTerms: String(r.standardTerms ?? ''),
    maxTerms: String(r.maxTerms ?? ''),
    cr: num(r.cr),
    iap: num(r.iap),
    hoursMatrix: r.hoursMatrix as TranscriptData['hoursMatrix'],
    entries: entries.map((e) => ({
      term: String(e.term),
      nature: (e.nature as string | null) ?? null,
      code: String(e.code),
      name: String(e.name),
      hours: Number(e.hours),
      grade: num(e.grade),
      status: String(e.status),
      instructor: (e.instructor as string | null) ?? null,
    })),
    pending: pending.map((p) => ({
      code: String(p.code),
      name: String(p.name),
      hours: Number(p.hours),
      enrolled: Boolean(p.enrolled),
    })),
    equivalences: (r.equivalences as string[] | undefined) ?? [],
    notes: (r.notes as string[] | undefined) ?? [],
  };
}

/**
 * Histórico acadêmico: importação (a única parte que vai ao SIGAA e usa IA) e insights (só banco).
 */
@Injectable()
export class HistoricoService {
  constructor(
    private readonly read: ReadRepository,
    private readonly transcripts: TranscriptRepository,
    private readonly source: TranscriptSource,
    @Inject(HISTORY_EXTRACTOR) private readonly extractor: HistoryExtractor,
  ) {}

  /** Baixa o PDF no SIGAA, extrai, valida e grava. A senha é usada em memória e descartada. */
  async importar(input: {
    userId: string;
    username: string;
    password: string;
  }): Promise<Lido<ImportedTranscript>> {
    const pdf = await this.source.fetchTranscriptPdf({
      userId: input.userId,
      accountKey: 'sigaa',
      credentials: { kind: 'password', username: input.username, password: input.password },
    });
    const imported = await importTranscript(this.extractor, pdf);
    const atualizadoEm = await this.transcripts.save(input.userId, imported.transcript);
    return { atualizadoEm, dados: imported };
  }

  /** Só banco: calcula a partir do histórico já importado. `dados` é null se nunca importado. */
  async insights(userId: string, tipo: InsightTipo): Promise<Lido<unknown | null>> {
    const stored = await this.read.getTranscript(userId);
    if (!stored) return { atualizadoEm: null, dados: null };
    const all: TranscriptInsights = transcriptInsights(toTranscriptData(stored.data));
    const dados =
      tipo === 'cr'
        ? { cr: all.cr, horasIntegralizadas: all.hoursCompleted }
        : tipo === 'trajetoria'
          ? all.trajectory
          : all.pending;
    return { atualizadoEm: stored.importedAt, dados };
  }
}
