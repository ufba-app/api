import type {
  HoursRow,
  TranscriptData,
  TranscriptEntry,
  TranscriptPending,
} from '../../../../domain/academic';

/**
 * JSON Schema entregue ao modelo (tool input_schema). Deliberadamente sem campo para CPF, nome,
 * nascimento, RG ou qualquer dado pessoal: o que não tem campo não é extraído.
 */
const hoursRowSchema = {
  type: 'object',
  properties: {
    required: { type: 'number' },
    done: { type: 'number' },
    pending: { type: 'number' },
  },
  required: ['required', 'done', 'pending'],
};

export const TRANSCRIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    issuedAt: { type: 'string', description: 'Data de emissão, AAAA-MM-DD' },
    curriculumCode: { type: 'string' },
    programName: { type: 'string' },
    currentTerm: { type: 'integer', description: 'Período letivo atual do aluno' },
    standardTerms: { type: 'string', description: 'Prazo padrão de conclusão, como impresso' },
    maxTerms: { type: 'string', description: 'Prazo máximo de conclusão, como impresso' },
    cr: { type: ['number', 'null'] },
    iap: { type: ['number', 'null'] },
    hoursMatrix: {
      type: 'object',
      description: 'Quadro de carga horária como o documento declara',
      properties: {
        required: hoursRowSchema,
        elective: hoursRowSchema,
        complementary: hoursRowSchema,
        total: hoursRowSchema,
      },
      required: ['required', 'elective', 'complementary', 'total'],
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'AAAA.N' },
          nature: { type: ['string', 'null'], description: 'OB, OP, EB, EP, LV, EC; nulo em trancamento' },
          code: { type: 'string' },
          name: { type: 'string' },
          hours: { type: 'integer' },
          grade: { type: ['number', 'null'], description: 'Nulo quando o documento imprime --' },
          status: { type: 'string', description: 'Sigla como impressa: APR, REP, TRANC, MATR...' },
          instructor: { type: ['string', 'null'] },
        },
        required: ['term', 'nature', 'code', 'name', 'hours', 'grade', 'status', 'instructor'],
      },
    },
    pending: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          hours: { type: 'integer' },
          enrolled: { type: 'boolean', description: 'Anotado como Matriculado' },
        },
        required: ['code', 'name', 'hours', 'enrolled'],
      },
    },
    equivalences: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'issuedAt',
    'curriculumCode',
    'programName',
    'currentTerm',
    'standardTerms',
    'maxTerms',
    'cr',
    'iap',
    'hoursMatrix',
    'entries',
    'pending',
    'equivalences',
    'notes',
  ],
};

export class TranscriptShapeError extends Error {
  constructor(message: string) {
    super(`Resposta da extração fora do formato: ${message}`);
    this.name = 'TranscriptShapeError';
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new TranscriptShapeError(`${path} deveria ser objeto`);
  }
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new TranscriptShapeError(`${path} deveria ser lista`);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new TranscriptShapeError(`${path} deveria ser texto`);
  return v.trim();
}
function strOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, path);
  return s === '' || s === '-' || s === '--' ? null : s;
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TranscriptShapeError(`${path} deveria ser número`);
  }
  return v;
}
function numOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : num(v, path);
}
function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) throw new TranscriptShapeError(`${path} deveria ser inteiro`);
  return n;
}

function hoursRow(v: unknown, path: string): HoursRow {
  const o = obj(v, path);
  return {
    required: num(o.required, `${path}.required`),
    done: num(o.done, `${path}.done`),
    pending: num(o.pending, `${path}.pending`),
  };
}

/**
 * JSON estrito do modelo → `TranscriptData`. Só copia campos conhecidos: qualquer campo extra
 * (um CPF que o modelo resolveu devolver, por exemplo) é descartado aqui. Estrutura errada lança;
 * valor plausível porém errado é problema do validador, não deste mapeador.
 */
export function toTranscriptData(raw: unknown): TranscriptData {
  const o = obj(raw, 'raiz');
  const issuedAt = str(o.issuedAt, 'issuedAt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) {
    throw new TranscriptShapeError('issuedAt deveria ser AAAA-MM-DD');
  }
  const matrix = obj(o.hoursMatrix, 'hoursMatrix');

  const entries = arr(o.entries, 'entries').map((e, i): TranscriptEntry => {
    const p = `entries[${i}]`;
    const r = obj(e, p);
    const term = str(r.term, `${p}.term`);
    if (!/^\d{4}\.\d$/.test(term)) throw new TranscriptShapeError(`${p}.term deveria ser AAAA.N`);
    return {
      term,
      nature: strOrNull(r.nature, `${p}.nature`),
      code: str(r.code, `${p}.code`),
      name: str(r.name, `${p}.name`),
      hours: int(r.hours, `${p}.hours`),
      grade: numOrNull(r.grade, `${p}.grade`),
      status: str(r.status, `${p}.status`),
      instructor: strOrNull(r.instructor, `${p}.instructor`),
    };
  });

  const pending = arr(o.pending, 'pending').map((e, i): TranscriptPending => {
    const p = `pending[${i}]`;
    const r = obj(e, p);
    if (typeof r.enrolled !== 'boolean') throw new TranscriptShapeError(`${p}.enrolled deveria ser booleano`);
    return {
      code: str(r.code, `${p}.code`),
      name: str(r.name, `${p}.name`),
      hours: int(r.hours, `${p}.hours`),
      enrolled: r.enrolled,
    };
  });

  return {
    issuedAt,
    curriculumCode: str(o.curriculumCode, 'curriculumCode'),
    programName: str(o.programName, 'programName'),
    currentTerm: int(o.currentTerm, 'currentTerm'),
    standardTerms: str(o.standardTerms, 'standardTerms'),
    maxTerms: str(o.maxTerms, 'maxTerms'),
    cr: numOrNull(o.cr, 'cr'),
    iap: numOrNull(o.iap, 'iap'),
    hoursMatrix: {
      required: hoursRow(matrix.required, 'hoursMatrix.required'),
      elective: hoursRow(matrix.elective, 'hoursMatrix.elective'),
      complementary: hoursRow(matrix.complementary, 'hoursMatrix.complementary'),
      total: hoursRow(matrix.total, 'hoursMatrix.total'),
    },
    entries,
    pending,
    equivalences: arr(o.equivalences, 'equivalences').map((s, i) => str(s, `equivalences[${i}]`)),
    notes: arr(o.notes, 'notes').map((s, i) => str(s, `notes[${i}]`)),
  };
}
