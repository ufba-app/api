/**
 * Expressões de pré-requisito, co-requisito e equivalência como o SIGAA as escreve: "( FISD36 E FISD42 ) OU ( ENGJ18 )".
 * `E` tem precedência sobre `OU` (álgebra booleana comum). Domínio puro, sem rede.
 */

// Código de componente: letras maiúsculas + dígitos, com uma letra final opcional (ENG295A).
const CODE_PATTERN = /[A-Z]{1,6}\d{1,4}[A-Z]?/g;
// "(" e ")" são tokens próprios mesmo colados a um código ("(FISD36"); por isso entram na mesma regex da tokenização.
const TOKEN_PATTERN = /\(|\)|\bOU\b|\bE\b|[A-Z]{1,6}\d{1,4}[A-Z]?/g;

type Token = { kind: 'OPEN' } | { kind: 'CLOSE' } | { kind: 'AND' } | { kind: 'OR' } | { kind: 'CODE'; code: string };

export type Expr =
  | { kind: 'CODE'; code: string }
  | { kind: 'AND'; left: Expr; right: Expr }
  | { kind: 'OR'; left: Expr; right: Expr };

function tokenize(text: string): Token[] {
  return (text.match(TOKEN_PATTERN) ?? []).map((raw): Token => {
    if (raw === '(') return { kind: 'OPEN' };
    if (raw === ')') return { kind: 'CLOSE' };
    if (raw === 'OU') return { kind: 'OR' };
    if (raw === 'E') return { kind: 'AND' };
    return { kind: 'CODE', code: raw };
  });
}

/** Descendente recursivo: `expr := term (OU term)*`, `term := factor (E factor)*`, `factor := CODE | '(' expr ')'`. */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Error('expressão malformada: sobrou texto no fim');
    return expr;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'OR') {
      this.pos++;
      left = { kind: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseFactor();
    while (this.peek()?.kind === 'AND') {
      this.pos++;
      left = { kind: 'AND', left, right: this.parseFactor() };
    }
    return left;
  }

  private parseFactor(): Expr {
    const token = this.peek();
    if (!token) throw new Error('expressão malformada: esperava código ou "("');
    if (token.kind === 'OPEN') {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.kind !== 'CLOSE') throw new Error('expressão malformada: parêntese não fechado');
      this.pos++;
      return inner;
    }
    if (token.kind === 'CODE') {
      this.pos++;
      return { kind: 'CODE', code: token.code };
    }
    throw new Error(`expressão malformada: token inesperado "${token.kind}"`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
}

function evaluate(expr: Expr, done: ReadonlySet<string>): boolean {
  if (expr.kind === 'CODE') return done.has(expr.code);
  if (expr.kind === 'AND') return evaluate(expr.left, done) && evaluate(expr.right, done);
  return evaluate(expr.left, done) || evaluate(expr.right, done);
}

/**
 * A árvore da expressão, ou `null` quando não há o que interpretar: vazia, sem nenhum código (por exemplo uma carga
 * horária mínima) ou malformada. Mesma regra de `checkExpression` para o que é `UNKNOWN`.
 */
export function parseExpression(text: string | null): Expr | null {
  if (!text || text.trim() === '') return null;
  const tokens = tokenize(text);
  if (!tokens.some((t) => t.kind === 'CODE')) return null;
  try {
    return new Parser(tokens).parse();
  } catch {
    return null;
  }
}

/** Todos os códigos citados na expressão, sem repetição e na ordem em que aparecem. */
export function citedCodes(text: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.match(CODE_PATTERN) ?? [])];
}

export type PrerequisiteCheck = 'MET' | 'NOT_MET' | 'UNKNOWN';

/**
 * Avalia a expressão contra os códigos que a pessoa já cumpriu. Vazia: `MET`. Texto sem nenhum código reconhecível (por
 * exemplo uma carga horária mínima) ou malformado: `UNKNOWN`, nunca `MET` (falha fechado: não mostrar "liberada" para uma
 * condição que não deu para verificar).
 */
export function checkExpression(text: string | null, done: ReadonlySet<string>): PrerequisiteCheck {
  if (!text || text.trim() === '') return 'MET';
  const tokens = tokenize(text);
  if (!tokens.some((t) => t.kind === 'CODE')) return 'UNKNOWN';
  try {
    return evaluate(new Parser(tokens).parse(), done) ? 'MET' : 'NOT_MET';
  } catch {
    return 'UNKNOWN';
  }
}

/** Verdadeiro só quando a expressão está comprovadamente satisfeita. */
export function isExpressionMet(text: string | null, done: ReadonlySet<string>): boolean {
  return checkExpression(text, done) === 'MET';
}
