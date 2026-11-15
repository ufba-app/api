import type { TextItem } from '../../ports/transcript';

/**
 * Redação do documento inteiro: a única parte determinística do caminho em que a IA lê o histórico. Tem de FALHAR
 * FECHADO: na dúvida, não envia nada.
 *
 * Lista de permissão, não de bloqueio: antes da tabela de cursados só sobrevivem as linhas cujo rótulo está em
 * `ALLOWED_HEADER`; todo o resto do cabeçalho (nome, matrícula, nascimento, CPF, documento, ingresso...) é descartado sem
 * ser lido. Da tabela em diante vai tudo, menos as linhas de docente e o rodapé com o código de verificação.
 *
 * Depois, uma rede de segurança confere a saída contra a identidade que o próprio documento declara (nome, matrícula,
 * CPF) e contra a forma de CPF, matrícula e código de verificação. Se qualquer uma aparecer, lança `RedactionFailed` e
 * nada é enviado. Origem: `poc-historico/src/ia/redator-documento.ts` (canário de privacidade portado).
 */
export class RedactionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionFailed';
  }
}

const COMPONENTS_TITLE = 'Componentes Curriculares Cursados/Cursando';

/** Único trecho do cabeçalho que segue adiante: o que o histórico precisa. */
const ALLOWED_HEADER: readonly RegExp[] = [/^Histórico Escolar/, /^Curso:/, /^IAP:/, /^CR:/, /^Currículo:/, /^Período Letivo Atual:/];

/** O que marca o fim do cabeçalho de uma página e o começo do conteúdo. */
const SECTION_MARKER: readonly RegExp[] = [
  /Componentes Curriculares Cursados\/Cursando/,
  /^Legenda/,
  /^Carga Horária e Créditos/,
  /^Componentes Curriculares Obrigatórios Pendentes/,
  /^Equival[êe]ncias/,
  /^Observa[çc][õo]es/,
  /^Semestre \| /,
  /^(\d{4}\.\d|--) \| /,
];

/** "Dr. FULANO DE TAL (60h)": a linha de docente termina na carga horária. */
const TEACHER_SUFFIX = /\(\s*\d+\s*h\s*\)\s*$/i;
const FREE_TEXT_SECTION = /^(Equival[êe]ncias|Observa[çc][õo]es)/;
const FOOTER = /autenticidade|verifica[çc][ãa]o|sigaa\.ufba\.br/i;

const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
const REGISTRATION = /\b\d{9}\b/;
const VERIFICATION_CODE = /\b(?=[0-9a-z]{10}\b)(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{10}\b/;

/** Início da banda do nome do componente; docente e nome ficam à direita disto. */
const NAME_BAND_START = 120;

interface Line {
  page: number;
  y: number;
  items: TextItem[];
  text: string;
}

function groupLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= 2) last.items.push(item);
    else lines.push({ page: item.page, y: item.y, items: [item], text: '' });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items
      .map((i) => i.text.trim())
      .filter(Boolean)
      .join(' | ');
  }
  return lines;
}

const isTeacherLine = (line: Line): boolean => line.items.every((i) => i.x >= NAME_BAND_START) && TEACHER_SUFFIX.test(line.text);

function valueOfLabel(items: TextItem[], label: string): string | null {
  const item = items.find((i) => i.text.startsWith(label));
  if (!item) return null;
  const embedded = item.text.slice(label.length).trim();
  if (embedded) return embedded;
  const neighbor = items
    .filter((i) => i !== item && i.page === item.page && Math.abs(i.y - item.y) <= 1.5 && i.x > item.x)
    .sort((a, b) => a.x - b.x)[0];
  return neighbor?.text.trim() || null;
}

/** O que o próprio documento declara como identidade do aluno, para conferir a saída. */
function declaredIdentity(items: TextItem[]): string[] {
  return ['Nome:', 'Matrícula:', 'Nº do CPF:']
    .map((label) => valueOfLabel(items, label))
    .filter((v): v is string => !!v && v.length >= 5);
}

function checkOutput(text: string, identity: string[]): void {
  const upper = text.toUpperCase();
  for (const term of identity) {
    if (upper.includes(term.toUpperCase())) {
      throw new RedactionFailed('A identidade declarada no documento sobrou no texto redigido. Nada foi enviado.');
    }
  }
  if (CPF.test(text) || REGISTRATION.test(text) || VERIFICATION_CODE.test(text)) {
    throw new RedactionFailed('O texto redigido tem a forma de CPF, matrícula ou código de verificação. Nada foi enviado.');
  }
}

export interface RedactedDocument {
  text: string;
  /** Contagens para o relatório; nunca conteúdo. */
  keptLines: number;
  droppedLines: number;
}

export function redactDocument(items: TextItem[]): RedactedDocument {
  const lines = groupLines(items);
  if (!lines.some((l) => l.text.includes(COMPONENTS_TITLE))) {
    // Sem esse marcador não dá para saber onde o cabeçalho com identidade acaba.
    throw new RedactionFailed('Não achei o início da tabela de cursados; sem ele não dá para separar a identidade. Nada foi enviado.');
  }

  // O cabeçalho (com nome e matrícula) se repete em toda página. Em cada página, tudo o que vem antes do primeiro marcador de
  // seção é cabeçalho e passa pela lista de permissão; uma página sem nenhum marcador é inteira cabeçalho.
  const firstMarkerByPage = new Map<number, number>();
  for (const [index, line] of lines.entries()) {
    if (!firstMarkerByPage.has(line.page) && SECTION_MARKER.some((p) => p.test(line.text))) firstMarkerByPage.set(line.page, index);
  }

  const kept: string[] = [];
  let inFreeText = false;
  for (const [index, line] of lines.entries()) {
    const marker = firstMarkerByPage.get(line.page);
    if (marker === undefined || index < marker) {
      if (ALLOWED_HEADER.some((p) => p.test(line.text))) kept.push(line.text);
      continue;
    }
    if (FREE_TEXT_SECTION.test(line.text)) inFreeText = true;
    if (FOOTER.test(line.text)) continue;
    if (!inFreeText && isTeacherLine(line)) continue;
    kept.push(line.text);
  }

  const text = kept.join('\n');
  checkOutput(text, declaredIdentity(items));
  return { text, keptLines: kept.length, droppedLines: lines.length - kept.length };
}
