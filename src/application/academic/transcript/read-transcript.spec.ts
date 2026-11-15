import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurriculumComponentInput } from '../../../domain/academic/progress';
import { TranscriptReader, type TextItem } from '../../ports/transcript';
import type { TranscriptDocument } from './contract';
import { readTranscript } from './read-transcript';
import { RedactionFailed, redactDocument } from './redactor';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');

// Itens de texto do PDF (histórico fictício, já anonimizado) e o que um modelo PERFEITO devolveria dele.
const items: TextItem[] = (JSON.parse(fixture('transcript-items.json')) as { pagina: number; x: number; y: number; texto: string }[]).map(
  (i) => ({ page: i.pagina, x: i.x, y: i.y, text: i.texto }),
);
const perfect = (): TranscriptDocument => JSON.parse(fixture('transcript-contract.json')) as TranscriptDocument;

class FixedReader extends TranscriptReader {
  readonly received: string[] = [];
  constructor(private readonly document: TranscriptDocument) {
    super();
  }
  async read(text: string) {
    this.received.push(text);
    return { document: this.document, usage: { inputTokens: 5000, outputTokens: 3000 } };
  }
}

const withoutTitle = (list: TextItem[]) => list.filter((i) => !i.text.includes('Componentes Curriculares Cursados/Cursando'));

describe('redactDocument (canário de privacidade)', () => {
  const { text } = redactDocument(items);

  it.each([
    ['nome do aluno', 'MARIA DA SILVA SANTOS'],
    ['matrícula', '209900011'],
    ['CPF', '111.222.333-44'],
    ['nascimento', '15/03/2001'],
    ['local de nascimento', 'CIDADE FICTICIA'],
    ['documento de identidade', '9999999999'],
    ['código de verificação', 'aaaa1111bb'],
    ['docente', 'ANA PEREIRA LIMA'],
    ['docente (sem título)', 'ELISA MOURA BRAGA'],
    ['forma de ingresso', 'Sisu'],
  ])('não deixa passar: %s', (_name, snippet) => {
    expect(text).not.toContain(snippet);
  });

  it('mantém o que o histórico precisa', () => {
    expect(text).toContain('Emitido em: 19/08/2026');
    expect(text).toContain('CR: | 8.1597');
    expect(text).toContain('FISD36');
    expect(text).toContain('FÍSICA GERAL TEÓRICA I');
    expect(text).toContain('Componentes Curriculares Obrigatórios Pendentes:20');
    expect(text).toContain('Cumpriu GENG0032');
    expect(text).toContain('atípico');
  });

  it('não confunde a equivalência (termina em "(60h)") com docente', () => {
    expect(text).toMatch(/Cumpriu GENG0032.*\(60h\)/);
  });

  it('só conta linhas, nunca conteúdo', () => {
    const r = redactDocument(items);
    expect(r.keptLines).toBeGreaterThan(50);
    expect(r.droppedLines).toBeGreaterThan(0);
  });

  it('falha fechado quando a identidade sobra numa linha permitida', () => {
    const leaked = items.map((i) => (i.text.startsWith('ENGENHARIA DA COMPUTAÇÃO') ? { ...i, text: `${i.text} MARIA DA SILVA SANTOS` } : i));
    expect(() => redactDocument(leaked)).toThrow(RedactionFailed);
  });

  it('falha fechado sem o marcador da tabela de cursados', () => {
    expect(() => redactDocument(withoutTitle(items))).toThrow(/Nada foi enviado/);
  });
});

describe('readTranscript', () => {
  it('envia só o texto redigido ao leitor', async () => {
    const reader = new FixedReader(perfect());
    await readTranscript(items, reader);
    expect(reader.received).toHaveLength(1);
    expect(reader.received[0]).not.toContain('MARIA DA SILVA SANTOS');
    expect(reader.received[0]).not.toContain('111.222.333-44');
  });

  it('um modelo perfeito entrega o contrato verificado, com o uso de tokens', async () => {
    const { contract, usage } = await readTranscript(items, new FixedReader(perfect()));
    expect(contract.contractVersion).toBe('1');
    expect(contract.verification).toEqual({ verified: true, warnings: [], reader: 'ai' });
    expect(contract.components).toHaveLength(49);
    expect(contract.pendingMandatory.items).toHaveLength(20);
    expect(usage).toEqual({ inputTokens: 5000, outputTokens: 3000 });
  });

  it('o contrato segue o documento de cima para baixo, na ordem de chaves esperada, sem docente nem banco', async () => {
    const { contract } = await readTranscript(items, new FixedReader(perfect()));
    expect(Object.keys(contract)).toEqual([
      'contractVersion', 'document', 'program', 'indices', 'components', 'hours', 'pendingMandatory', 'equivalences', 'notes', 'verification',
    ]);
    expect(Object.keys(contract.components[0])).toEqual(['term', 'kind', 'code', 'name', 'hours', 'grade', 'status']);
    expect(Object.keys(contract.hours.mandatory)).toEqual(['required', 'completed', 'pending']);
    expect(JSON.stringify(contract)).not.toMatch(/docente|professor|prisma|historicoId|instructor/i);
  });

  it('nota errada: entrega mesmo assim, mas não verificado e com o motivo', async () => {
    const doc = perfect();
    doc.components[0] = { ...doc.components[0], grade: 1 };
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
    expect(contract.verification.warnings[0]).toMatch(/CR recalculado/);
    expect(contract.components).toHaveLength(49);
  });

  it('linha omitida pelo modelo: horas não fecham, não verificado', async () => {
    const doc = perfect();
    doc.components.splice(0, 1);
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
    expect(contract.verification.warnings.join(' ')).toMatch(/carga horária somada/);
  });

  it('horas das linhas diferentes do quadro COM aproveitamento (semestre "--"): verificado, só aviso', async () => {
    const doc = perfect();
    doc.components.push({ term: '--', kind: 'OB', code: 'XXXX0001', name: 'APROVEITADA', hours: 18, grade: null, status: 'CUMP' });
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(true);
    expect(contract.verification.warnings).toHaveLength(1);
    expect(contract.verification.warnings[0]).toMatch(/carga horária somada/);
  });

  it('o CR do SIGAA não conta o aproveitamento: linha "--" com nota não derruba o verificado', async () => {
    const doc = perfect();
    doc.components.push({ term: '--', kind: 'OP', code: 'XXXX0002', name: 'APROVEITADA COM NOTA', hours: 60, grade: 10, status: 'CUMP' });
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(true);
    expect(contract.verification.warnings).toHaveLength(1);
  });

  it('a mesma linha com nota, mas com semestre normal, derruba o verificado (CR não fecha)', async () => {
    const doc = perfect();
    doc.components.push({ term: '2024.1', kind: 'OP', code: 'XXXX0002', name: 'EXTRA COM NOTA', hours: 60, grade: 10, status: 'CUMP' });
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
  });

  it('a mesma diferença SEM aproveitamento continua derrubando o verificado', async () => {
    const doc = perfect();
    doc.components.push({ term: '2024.1', kind: 'OB', code: 'XXXX0001', name: 'EXTRA', hours: 18, grade: null, status: 'CUMP' });
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
  });

  it('com aproveitamento, CR errado ainda derruba o verificado', async () => {
    const doc = perfect();
    doc.components.push({ term: '--', kind: 'OB', code: 'XXXX0001', name: 'APROVEITADA', hours: 18, grade: null, status: 'CUMP' });
    doc.components[0] = { ...doc.components[0], grade: 1 };
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
  });

  it('pendentes que não batem com o título: não verificado', async () => {
    const doc = perfect();
    doc.pendingMandatory.items = doc.pendingMandatory.items.slice(1);
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
    expect(contract.verification.warnings.join(' ')).toMatch(/pendentes/);
  });

  it('data fora do formato vira aviso duro', async () => {
    const doc = perfect();
    doc.document.issuedOn = '19/08/2026';
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.verification.verified).toBe(false);
    expect(contract.verification.warnings.join(' ')).toMatch(/AAAA-MM-DD/);
  });

  it('sigla de situação fora da legenda: AVISO, a linha segue e não conta como cumprida', async () => {
    const doc = perfect();
    doc.components[0] = { ...doc.components[0], status: 'NOVA' };
    const { contract } = await readTranscript(items, new FixedReader(doc));
    expect(contract.components[0].status).toBe('NOVA');
    expect(contract.verification.warnings.join(' ')).toMatch(/Situação fora da legenda conhecida: NOVA/);
  });

  it('se a chamada ao modelo falha, o erro sobe (não há leitura para entregar)', async () => {
    const reader = new (class extends TranscriptReader {
      async read(): Promise<never> {
        throw new Error('sem crédito');
      }
    })();
    await expect(readTranscript(items, reader)).rejects.toThrow('sem crédito');
  });

  it('se a redação recusa, o modelo nem é chamado', async () => {
    const reader = new FixedReader(perfect());
    await expect(readTranscript(withoutTitle(items), reader)).rejects.toThrow(RedactionFailed);
    expect(reader.received).toHaveLength(0);
  });
});

describe('readTranscript com o catálogo do curso (conferência determinística)', () => {
  /** Um currículo fictício que contém exatamente os obrigatórios do histórico, com as mesmas horas. */
  const curriculumOf = (doc: TranscriptDocument): CurriculumComponentInput[] =>
    doc.components
      .filter((c) => c.kind === 'OB')
      .map((c) => ({ code: c.code, name: c.name, hours: c.hours, nature: 'REQUIRED', term: 1, prerequisiteExpr: null, corequisiteExpr: null, equivalenceExpr: null }));

  it('tudo existe no curso, com as mesmas horas: sem avisos', async () => {
    const { contract } = await readTranscript(items, new FixedReader(perfect()), { curriculumComponents: curriculumOf(perfect()) });
    expect(contract.verification).toEqual({ verified: true, warnings: [], reader: 'ai' });
  });

  it('um obrigatório fora do curso: só aviso (pode ser currículo antigo)', async () => {
    const curriculum = curriculumOf(perfect()).slice(1);
    const { contract } = await readTranscript(items, new FixedReader(perfect()), { curriculumComponents: curriculum });
    expect(contract.verification.verified).toBe(true);
    expect(contract.verification.warnings.join(' ')).toMatch(/1 componente\(s\) obrigatório\(s\) do histórico não existem no currículo/);
  });

  it('muitos obrigatórios fora do curso: leitura suspeita, não verificado', async () => {
    const curriculum = curriculumOf(perfect()).slice(0, 5);
    const { contract } = await readTranscript(items, new FixedReader(perfect()), { curriculumComponents: curriculum });
    expect(contract.verification.verified).toBe(false);
  });

  it('um obrigatório que o curso substitui por equivalência não é suspeito', async () => {
    const doc = perfect();
    const first = doc.components.find((c) => c.kind === 'OB')!;
    const curriculum = curriculumOf(doc).filter((c) => c.code !== first.code);
    curriculum[0] = { ...curriculum[0], equivalenceExpr: `( ${first.code} )` };
    const { contract } = await readTranscript(items, new FixedReader(doc), { curriculumComponents: curriculum });
    expect(contract.verification.warnings).toEqual([]);
  });

  it('horas diferentes do curso: aviso com os dois valores', async () => {
    const curriculum = curriculumOf(perfect());
    curriculum[0] = { ...curriculum[0], hours: curriculum[0].hours + 15 };
    const { contract } = await readTranscript(items, new FixedReader(perfect()), { curriculumComponents: curriculum });
    expect(contract.verification.verified).toBe(true);
    expect(contract.verification.warnings.join(' ')).toMatch(/Carga horária diferente da do curso/);
  });

  it('sem o catálogo pronto, a conferência é pulada', async () => {
    const { contract } = await readTranscript(items, new FixedReader(perfect()), { curriculumComponents: [] });
    expect(contract.verification.warnings).toEqual([]);
  });
});
