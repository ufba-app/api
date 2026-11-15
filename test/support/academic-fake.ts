import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptContract, TranscriptDocument } from '../../src/application/academic/transcript/contract';
import type { CatalogComponent } from '../../src/application/ports/catalog';
import { PdfTextExtractor, TranscriptReader, type TextItem } from '../../src/application/ports/transcript';
import {
  AcademicRepository,
  TranscriptSource,
  type ImportLogEntry,
  type ImportState,
  type PortalProfile,
  type TranscriptSnapshot,
} from '../../src/application/ports/academic';

/** Vida acadêmica em memória (mesma semântica do repositório do Postgres). */
export class InMemoryAcademic extends AcademicRepository {
  consents = new Map<string, { acceptedAt: Date; version: number }>();
  imports = new Map<string, ImportState>();
  logs: ImportLogEntry[] = [];
  transcripts = new Map<string, TranscriptContract>();
  profiles = new Map<string, PortalProfile>();

  async getConsent(userId: string) {
    return this.consents.get(userId) ?? null;
  }
  async saveConsent(userId: string, version: number, at: Date) {
    this.consents.set(userId, { acceptedAt: at, version });
  }
  async deleteConsent(userId: string) {
    this.consents.delete(userId);
  }
  async getImport(userId: string) {
    return this.imports.get(userId) ?? null;
  }
  async saveImport(state: ImportState) {
    this.imports.set(state.userId, { ...state });
  }
  async deleteImport(userId: string) {
    this.imports.delete(userId);
  }
  async addLog(entry: ImportLogEntry) {
    this.logs.push(entry);
  }
  async countLogsSince(userId: string, since: Date) {
    return this.logs.filter((l) => l.userId === userId && l.startedAt >= since).length;
  }
  async usageSince(since: Date) {
    const mine = this.logs.filter((l) => l.startedAt >= since);
    return {
      inputTokens: mine.reduce((s, l) => s + (l.inputTokens ?? 0), 0),
      outputTokens: mine.reduce((s, l) => s + (l.outputTokens ?? 0), 0),
    };
  }
  async replaceTranscript(userId: string, contract: TranscriptContract) {
    this.transcripts.set(userId, structuredClone(contract));
  }
  async findTranscript(userId: string) {
    return this.transcripts.get(userId) ?? null;
  }
  async deleteTranscript(userId: string) {
    this.transcripts.delete(userId);
  }
  async saveProfile(userId: string, profile: PortalProfile) {
    this.profiles.set(userId, profile);
  }
  async clearProfile(userId: string) {
    this.profiles.delete(userId);
  }
}

/** Fonte falsa: devolve o que o teste mandar e conta as chamadas (sem rede, sem SIGAA). */
export class FakeTranscriptSource extends TranscriptSource {
  calls = 0;
  snapshot: TranscriptSnapshot = {
    pdf: Buffer.from('%PDF-fake'),
    profile: { registration: '123456789', program: 'ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador', entryTerm: '2022.1' },
  };
  error: Error | null = null;
  async fetch() {
    this.calls++;
    if (this.error) throw this.error;
    return this.snapshot;
  }
}

// ---- histórico de exemplo (fictício, anonimizado) e leitor/extrator falsos, para os testes do serviço e do HTTP ----

const fixtureDir = join(__dirname, '..', '..', 'src', 'application', 'academic', 'transcript', '__fixtures__');
const fixture = (name: string) => readFileSync(join(fixtureDir, name), 'utf-8');

/** Itens de texto do PDF do histórico fictício (o que o extrator real devolveria). */
export const TRANSCRIPT_ITEMS: TextItem[] = (
  JSON.parse(fixture('transcript-items.json')) as { pagina: number; x: number; y: number; texto: string }[]
).map((i) => ({ page: i.pagina, x: i.x, y: i.y, text: i.texto }));

/** O que um modelo PERFEITO devolveria desse histórico. */
export const perfectTranscript = (): TranscriptDocument => JSON.parse(fixture('transcript-contract.json')) as TranscriptDocument;

/** O currículo Ativo fictício do curso: exatamente os obrigatórios do histórico de exemplo, com as mesmas horas. */
export const curriculumOf = (doc: TranscriptDocument): CatalogComponent[] =>
  doc.components
    .filter((c) => c.kind === 'OB')
    .map((c, i) => ({
      sigaaId: String(i + 1),
      code: c.code,
      name: c.name,
      hours: c.hours,
      nature: 'REQUIRED' as const,
      term: 1 + (i % 10),
      responsibleUnit: null,
      prerequisiteExpr: null,
      corequisiteExpr: null,
      equivalenceExpr: null,
    }));

export class FakeExtractor extends PdfTextExtractor {
  items: TextItem[] = TRANSCRIPT_ITEMS;
  fail = false;
  async extract() {
    if (this.fail) throw new Error('não é um pdf');
    return this.items;
  }
}

export class FakeReader extends TranscriptReader {
  document: TranscriptDocument = perfectTranscript();
  calls = 0;
  fail = false;
  async read() {
    this.calls++;
    if (this.fail) throw new Error('sem crédito');
    return { document: this.document, usage: { inputTokens: 5000, outputTokens: 3000 } };
  }
}
