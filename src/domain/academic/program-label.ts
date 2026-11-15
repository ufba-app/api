/**
 * O curso como o histórico do SIGAA escreve: `NOME/UNIDADE - CAMPUS - GRAU - MODALIDADE - TURNO`
 * (ex.: `ENGENHARIA DA COMPUTAÇÃO/EPOLI - SALVADOR - BACHARELADO - PRESENCIAL - N`). Este parser só serve para a tela
 * mostrar um título curto; o texto original (`raw`) vai sempre junto e NUNCA é perdido.
 *
 * Degraus (nunca lança, nunca devolve vazio quando há texto):
 * 1. `full`: 5 pedaços. Título + campus, grau, modalidade e turno.
 * 2. `partial`: de 1 a 4 pedaços. Título e só os pedaços que existem (por posição), sem inventar os que faltam.
 * 3. valor desconhecido (grau, modalidade ou turno que não estão nas tabelas): aparece como veio (só a caixa muda).
 * 4. `raw`: nada que se aproveite (vazio, ou sem nome antes do primeiro " - "). `name` é o texto original.
 */
export interface ProgramLabel {
  /** O texto original, sempre. */
  raw: string;
  /** O título: "Engenharia da Computação". Em `raw`, o próprio texto original. */
  name: string;
  /** Sigla da unidade: "EPOLI". */
  unit: string | null;
  campus: string | null;
  degree: string | null;
  modality: string | null;
  shift: string | null;
  format: 'full' | 'partial' | 'raw';
}

const LOWER = new Set(['a', 'o', 'as', 'os', 'e', 'em', 'de', 'da', 'do', 'das', 'dos', 'para', 'com', 'no', 'na', 'nos', 'nas', 'ou']);
const ROMAN = /^(?:I{1,3}|IV|VI{0,3}|IX|X)$/;
const SEPARATOR = ' - ';

/** "ENGENHARIA DA COMPUTAÇÃO" → "Engenharia da Computação". Siglas com dígito e algarismos romanos ficam como estão. */
export function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      if (/\d/.test(word) || ROMAN.test(word)) return word;
      const lower = word.toLocaleLowerCase('pt-BR');
      if (i > 0 && LOWER.has(lower)) return lower;
      return lower.replace(/(^|[-'(/])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase('pt-BR'));
    })
    .join(' ');
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();

const DEGREES: Record<string, string> = { BACHARELADO: 'Bacharelado', LICENCIATURA: 'Licenciatura', TECNOLOGICO: 'Tecnológico', TECNOLOGO: 'Tecnólogo' };
const MODALITIES: Record<string, string> = { PRESENCIAL: 'Presencial', 'A DISTANCIA': 'A distância', EAD: 'A distância', SEMIPRESENCIAL: 'Semipresencial' };
/** Letras do turno no SIGAA. Fora da tabela (ou por extenso), o valor aparece como veio. */
const SHIFTS: Record<string, string> = { M: 'Matutino', T: 'Vespertino', N: 'Noturno', I: 'Integral' };

const degree = (s: string) => DEGREES[norm(s)] ?? titleCase(s);
const modality = (s: string) => MODALITIES[norm(s)] ?? titleCase(s);
const shift = (s: string) => SHIFTS[norm(s)] ?? (s.length <= 2 ? s.trim() : titleCase(s));

const empty = (raw: string): ProgramLabel => ({ raw, name: raw, unit: null, campus: null, degree: null, modality: null, shift: null, format: 'raw' });

export function parseProgramLabel(rawInput: string): ProgramLabel {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const parts = raw
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter((_, i, all) => !(i === all.length - 1 && all[i] === '' && all.length > 1));
  if (parts.length === 0 || parts[0] === '') return empty(raw);

  let head = parts[0];
  let rest = parts.slice(1);
  // Mais de 5 pedaços: o nome tem " - " dentro. Vale se os 4 últimos parecem campus/grau/modalidade/turno.
  if (parts.length > 5) {
    const tail = parts.slice(-4);
    if (!(norm(tail[1]) in DEGREES) && !(norm(tail[2]) in MODALITIES)) return empty(raw);
    head = parts.slice(0, parts.length - 4).join(SEPARATOR);
    rest = tail;
  }

  const slash = head.lastIndexOf('/');
  const nameText = (slash >= 0 ? head.slice(0, slash) : head).trim();
  const unitText = slash >= 0 ? head.slice(slash + 1).trim() : '';
  if (!nameText) return empty(raw);

  const [campus, deg, mod, sh] = rest;
  return {
    raw,
    name: titleCase(nameText),
    unit: unitText || null,
    campus: campus ? titleCase(campus) : null,
    degree: deg ? degree(deg) : null,
    modality: mod ? modality(mod) : null,
    shift: sh ? shift(sh) : null,
    format: rest.length === 4 ? 'full' : 'partial',
  };
}

/** O que mudou o degrau, sem texto nenhum: serve para contar formatos novos sem expor o curso de ninguém. */
export function labelShape(raw: string, label: ProgramLabel): string {
  if (label.format === 'raw') return 'raw';
  const parts = raw.split(SEPARATOR).length;
  const unknown = [
    label.degree !== null && !(norm(label.degree) in DEGREES) ? 'grau' : '',
    label.modality !== null && !(norm(label.modality) in MODALITIES) ? 'modalidade' : '',
    label.shift !== null && !(norm(label.shift) in SHIFTS) && !Object.values(SHIFTS).includes(label.shift) ? 'turno' : '',
  ].filter(Boolean);
  return `${label.format}:${parts}p${unknown.length ? `:desconhecido=${unknown.join('+')}` : ''}`;
}
