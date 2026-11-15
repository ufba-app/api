import {
  SiasbError,
  SiasbSession,
  type SiasbCourse,
  type SiasbErrorCode,
} from '../../../application/ports/siasb-source';
import type { Secret } from '../../../application/shared/secret';

export const SIASB_BASE_URL = 'https://api.siasb.ufba.br/api/v1';

const TIMEOUT_MS = 15_000;
const GET_RETRIES = 2;

const DATE_TIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}(?::|%3A)\\d{2}(?:(?::|%3A)\\d{2})?';

/**
 * Lista de rotas que o código consegue chamar, só GET, num único lugar (spec 5.1). Cada item casa o caminho inteiro,
 * com a query, sem barra dupla, `..` nem fragmento. Tudo o que não casa é FORBIDDEN_ROUTE antes de qualquer rede.
 * `student/attendances?status=4` (pacientes de outros alunos) e todo dado clínico ficam de fora de propósito.
 * `student/unassigned-attendances` NÃO está em `ALLOWED`: só `countUnassigned` a chama, e só devolve a contagem.
 */
const ALLOWED: readonly RegExp[] = [
  /^\/auth\/course-options\?username=\d{1,20}$/,
  /^\/auth\/session$/,
  /^\/student\/new-attendance\/disciplines$/,
  /^\/student\/attendances\?status=[123]$/,
  new RegExp(`^/student/schedule/sessions\\?startAt=${DATE_TIME}&endAt=${DATE_TIME}$`),
  /^\/student\/options\?kind=procedures&attendanceId=\d{1,12}$/,
  /^\/student\/options\?kind=(?:ambulatoryLocations|professors|patientGroups)(?:&attendanceId=\d{1,12})?$/,
];
const COUNT_ONLY: readonly RegExp[] = [/^\/student\/unassigned-attendances$/];

function isAllowed(path: string, table: readonly RegExp[]): boolean {
  return table.some((re) => re.test(path));
}

interface ParsedCookie {
  name: string;
  value: string;
  expires: Date | null;
  remove: boolean;
}

function parseSetCookie(line: string): ParsedCookie | null {
  const parts = line.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let expires: Date | null = null;
  let maxAge: number | null = null;
  for (const attr of parts) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'expires') {
      const d = new Date(val);
      if (!Number.isNaN(d.getTime())) expires = d;
    } else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) maxAge = n;
    }
  }
  if (maxAge !== null) expires = new Date(Date.now() + maxAge * 1000);
  const remove = value === '' || (expires !== null && expires.getTime() <= Date.now());
  return { name, value, expires, remove };
}

function readSetCookies(res: Response): ParsedCookie[] {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const out: ParsedCookie[] = [];
  for (const line of lines) {
    const c = parseSetCookie(line);
    if (c) out.push(c);
  }
  return out;
}

/** Aplica os cookies da resposta ao jar. Devolve `true` se algo mudou. */
function mergeCookies(session: SiasbSession, incoming: ParsedCookie[]): boolean {
  let changed = false;
  for (const c of incoming) {
    if (c.remove) {
      if (c.name in session.cookies) {
        delete session.cookies[c.name];
        changed = true;
      }
      continue;
    }
    if (session.cookies[c.name] !== c.value) {
      session.cookies[c.name] = c.value;
      changed = true;
    }
    if (c.expires && (!session.expiresAt || c.expires > session.expiresAt)) {
      session.expiresAt = c.expires;
      changed = true;
    }
  }
  return changed;
}

function cookieHeader(session: SiasbSession): string {
  return Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function fail(code: SiasbErrorCode, message: string): never {
  throw new SiasbError(code, message);
}

/**
 * Cliente HTTP do SIASB. Segurança:
 * - a senha só vira texto dentro de `login` (`reveal()`), e o corpo da requisição nunca é logado;
 * - mensagens de erro são fixas: sem corpo de resposta, sem erro original, sem nome ou valor de cookie, sem matrícula;
 * - só rotas da tabela `ALLOWED` saem daqui; o resto é FORBIDDEN_ROUTE sem tocar na rede;
 * - o login nunca repete (evita bloquear a conta); GET repete até 2 vezes, só em 5xx ou falha de rede.
 */
export class SiasbClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.baseUrl = (opts.baseUrl ?? SIASB_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
  }

  async courseOptions(registration: string): Promise<SiasbCourse[]> {
    const path = `/auth/course-options?username=${encodeURIComponent(registration)}`;
    if (!isAllowed(path, ALLOWED)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
    const res = await this.getWithRetry(path, undefined);
    const body = await this.readJson(res);
    if (!Array.isArray(body)) fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    return body.map((raw: unknown): SiasbCourse => {
      const o = (raw ?? {}) as Record<string, unknown>;
      if (
        typeof o.courseId !== 'number' ||
        typeof o.courseDescription !== 'string' ||
        typeof o.courseAbbreviation !== 'string'
      ) {
        fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
      }
      return {
        id: o.courseId,
        name: o.courseDescription,
        abbreviation: o.courseAbbreviation,
        isDefault: o.isDefaultSelection === true,
      };
    });
  }

  async login(
    registration: string,
    password: Secret,
    courseId: number,
  ): Promise<{ session: SiasbSession; username: string }> {
    // Único ponto onde a senha vira texto.
    const body = JSON.stringify({
      username: registration,
      password: password.reveal(),
      selectedCourseId: courseId,
      rememberMe: true,
    });
    const res = await this.send('/auth/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 409) {
      const parsed = await this.tryJson(res);
      const code = (parsed as { code?: unknown } | null)?.code;
      if (code === 'password_migration_required') {
        fail('PASSWORD_MIGRATION_REQUIRED', 'A senha do SIASB precisa ser atualizada no site do SIASB.');
      }
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      fail('CREDENTIAL_REJECTED', 'O SIASB recusou a matrícula ou a senha.');
    }
    if (res.status >= 500) fail('UNAVAILABLE', 'O SIASB está indisponível.');
    if (!res.ok) fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');

    const session = new SiasbSession();
    mergeCookies(session, readSetCookies(res));
    session.dirty = false;
    if (Object.keys(session.cookies).length === 0) {
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }

    const loginBody = await this.tryJson(res);
    let username = (loginBody as { username?: unknown } | null)?.username;
    if (typeof username !== 'string' || username === '') {
      const info = (await this.get(session, '/auth/session')) as { username?: unknown } | null;
      username = info?.username;
    }
    if (typeof username !== 'string' || username === '') {
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }
    session.dirty = false;
    return { session, username };
  }

  async get(session: SiasbSession, path: string): Promise<unknown> {
    if (!isAllowed(path, ALLOWED)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
    const res = await this.getWithRetry(path, session);
    return this.readJson(res);
  }

  /** Quantos pacientes sem responsável existem. A lista (com nomes de terceiros) nunca sai daqui. */
  async countUnassigned(session: SiasbSession): Promise<number> {
    const path = '/student/unassigned-attendances';
    if (!isAllowed(path, COUNT_ONLY)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
    const res = await this.getWithRetry(path, session);
    const body = await this.readJson(res);
    if (!Array.isArray(body)) fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    return body.length;
  }

  private async getWithRetry(path: string, session: SiasbSession | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (session) headers.Cookie = cookieHeader(session);

    let last: SiasbError | null = null;
    for (let attempt = 0; attempt <= GET_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await this.send(path, { method: 'GET', headers });
      } catch (e) {
        if (e instanceof SiasbError && e.code === 'UNAVAILABLE') {
          last = e;
          continue;
        }
        throw e;
      }
      if (res.status >= 500) {
        last = new SiasbError('UNAVAILABLE', 'O SIASB está indisponível.');
        continue;
      }
      if (res.status === 401) fail('REAUTH_NEEDED', 'A sessão do SIASB expirou. Conecte de novo.');
      if (!res.ok) fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
      if (session && mergeCookies(session, readSetCookies(res))) session.dirty = true;
      return res;
    }
    throw last ?? new SiasbError('UNAVAILABLE', 'O SIASB está indisponível.');
  }

  /** Uma chamada ao `fetch`. Falha de rede vira UNAVAILABLE, sem o erro original (pode ter URL com matrícula). */
  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SiasbError('UNAVAILABLE', 'O SIASB está indisponível.');
    }
  }

  private async readJson(res: Response): Promise<unknown> {
    if (res.status === 204) return null;
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new SiasbError('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }
  }

  private async tryJson(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }
}
