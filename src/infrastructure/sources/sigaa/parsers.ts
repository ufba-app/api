/** Parsers do portal discente (markup UFRN-family). Regex em vez de cheerio: sem dependência nova. */

export interface StudentProfile {
  registration: string | null;
  program: string | null;
  /** "AAAA.N". */
  entryTerm: string | null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

const TERM_PATTERN = /^\d{4}\.\d$/;
const ENTRY_LABEL_PATTERN = /\bentrada\b|ingresso/;

/**
 * Lê a caixa `#agenda-docente` da home do portal: linhas rótulo/valor. Todo campo é anulável:
 * mudança de layout degrada para nulo, nunca para erro.
 */
export function parseStudentProfile(html: string): StudentProfile {
  const profile: StudentProfile = {
    registration: null,
    program: null,
    entryTerm: null,
  };
  const start = html.search(/id="agenda-docente"/);
  if (start < 0) return profile;
  const rest = html.slice(start);
  const end = rest.search(/<\/table>/i);
  const block = end < 0 ? rest : rest.slice(0, end);

  for (const row of block.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cellText(m[1]),
    );
    if (cells.length < 2 || !cells[1]) continue;
    const label = normalizeLabel(cells[0]);
    const value = cells[1];
    if (label === 'matricula') profile.registration = value;
    else if (label === 'curso') profile.program = value;
    else if (ENTRY_LABEL_PATTERN.test(label)) {
      profile.entryTerm = TERM_PATTERN.test(value) ? value : null;
    }
  }
  return profile;
}

export interface MenuPostback {
  /** Hidden `id` do formulário do menu. */
  id: string;
  /** Token `jscook_action` completo do item. */
  jscookAction: string;
}

const HIDDEN_ID_PATTERN = /<input type="hidden" name="id" value="(\d+)"\s*\/?>/;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * O menu clássico dispara "Emitir Histórico" por um JSCookMenu. O `id` e o prefixo do token
 * variam por instalação (carregam um id de JSP gerado), então são lidos da página, ancorando na
 * expressão estável. O `\s*\}` evita casar `portalDiscente.historicoComDadosAdicionais`.
 */
export function parseHistoryMenuPostback(html: string): MenuPostback {
  const idMatch = HIDDEN_ID_PATTERN.exec(html);
  if (!idMatch) {
    throw new Error('Não achei o <input name="id"> do menu do portal discente');
  }
  const expression = 'portalDiscente.historico';
  const action = new RegExp(
    `'([^']*menu[^']*:A\\]#\\{\\s*${escapeForRegExp(expression)}\\s*\\})'`,
  ).exec(html);
  if (!action) {
    throw new Error(`Não achei o jscook_action de ${expression} no menu`);
  }
  return { id: idMatch[1], jscookAction: action[1] };
}
