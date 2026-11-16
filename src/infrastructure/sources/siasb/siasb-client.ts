import {
  SiasbError,
  SiasbSession,
  SiasbSource,
  type SiasbCourse,
  type ScheduleSessionsInput,
  type SchedulingOptions,
  type SiasbErrorCode,
  type WriteResult,
} from '../../../application/ports/siasb-source';
import type { Secret } from '../../../application/shared/secret';
import type {
  ClinicalAttendance,
  ClinicalDiscipline,
  ClinicalSession,
  Procedure,
} from '../../../domain/siasb/types';
import {
  countUnassigned,
  mapAttendances,
  mapDisciplines,
  mapProcedures,
  mapSchedulingOptions,
  mapSessions,
} from './siasb-mapper';

export const SIASB_BASE_URL = 'https://api.siasb.ufba.br/api/v1';

const TIMEOUT_MS = 15_000;
const GET_RETRIES = 2;
const RETRY_DELAY_MS = 300;

const DATE_TIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}(?::|%3A)\\d{2}(?:(?::|%3A)\\d{2})?';

/**
 * Lista de rotas que o código consegue chamar, só GET, num único lugar (spec 5.1). Cada item casa o caminho inteiro,
 * com a query, sem barra dupla, `..` nem fragmento. Tudo o que não casa é FORBIDDEN_ROUTE antes de qualquer rede.
 * `student/attendances?status=4` (pacientes de outros alunos) e todo dado clínico ficam de fora de propósito.
 * `student/unassigned-attendances` NÃO está em `ALLOWED`: só `unassignedCount` a chama, e só devolve contagens.
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

/**
 * Escritas permitidas, casadas por MÉTODO + caminho inteiro (ids só dígitos). Quatro operações e nada mais:
 * `realize`, falta e qualquer outra mudança clínica ficam de fora de propósito.
 */
const WRITE_ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/student\/schedule\/sessions$/ },
  { method: 'POST', path: /^\/student\/schedule\/sessions\/\d{1,12}\/disposition$/ },
  { method: 'POST', path: /^\/student\/attendances\/\d{1,12}\/procedures$/ },
  { method: 'DELETE', path: /^\/student\/attendances\/\d{1,12}\/procedures\/\d{1,12}$/ },
];
const UNKNOWN_WRITE = 'O SIASB não confirmou a operação.';
/** Únicas mensagens do SIASB que passam para a pessoa (só se o corpo for exatamente isto). */
const KNOWN_REJECTIONS: ReadonlySet<string> = new Set([
  'Você não possui aula desta disciplina neste dia e horário.',
  'O horário final ultrapassa o horário de aula da disciplina.',
]);

function isAllowed(path: string, table: readonly RegExp[]): boolean {
  return table.some((re) => re.test(path));
}

function isWriteAllowed(method: string, path: string): boolean {
  return WRITE_ALLOWED.some((r) => r.method === method && r.path.test(path));
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

/** Descarta o corpo de uma resposta que não vai ser lida (libera a conexão). */
function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/** Data e hora no formato do SIASB (`YYYY-MM-DDTHH:mm`), no horário da Bahia (UTC-3). */
function siasbDateTime(d: Date): string {
  return new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 16);
}

/** Como `siasbDateTime`, com segundos (`YYYY-MM-DDTHH:mm:ss`), para o corpo das escritas. */
function siasbDateTimeSeconds(d: Date): string {
  return new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 19);
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
export class SiasbClient extends SiasbSource {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelayMs: number;

  /**
   * `baseUrl` existe só para teste; em produção fica o padrão (`SIASB_BASE_URL`). `retryDelayMs` é a espera entre
   * as tentativas de um GET (os testes passam 0).
   */
  constructor(opts: { baseUrl?: string; fetch?: typeof fetch; retryDelayMs?: number } = {}) {
    super();
    this.baseUrl = (opts.baseUrl ?? SIASB_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
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

    if ((res.status >= 300 && res.status < 400) || res.status === 429) {
      discard(res);
      fail('UNAVAILABLE', 'O SIASB está indisponível.');
    }
    if (res.status === 409) {
      const parsed = await this.tryJson(res);
      const code = (parsed as { code?: unknown } | null)?.code;
      if (code === 'password_migration_required') {
        fail('PASSWORD_MIGRATION_REQUIRED', 'A senha do SIASB precisa ser atualizada no site do SIASB.');
      }
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      discard(res);
      fail('CREDENTIAL_REJECTED', 'O SIASB recusou a matrícula ou a senha.');
    }
    if (res.status >= 500) {
      discard(res);
      fail('UNAVAILABLE', 'O SIASB está indisponível.');
    }
    if (!res.ok) {
      discard(res);
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }

    const session = new SiasbSession();
    mergeCookies(session, readSetCookies(res));
    session.dirty = false;
    if (Object.keys(session.cookies).length === 0) {
      fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
    }

    // O titular vem da sessão aberta (auth/session), nunca do corpo do login: é ela que prova de quem é o cookie.
    discard(res);
    const info = (await this.get(session, '/auth/session')) as { username?: unknown } | null;
    const username = info?.username;
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

  async disciplines(session: SiasbSession): Promise<ClinicalDiscipline[]> {
    return mapDisciplines(await this.get(session, '/student/new-attendance/disciplines'));
  }

  async attendances(session: SiasbSession, which: 'active' | 'inactive'): Promise<ClinicalAttendance[]> {
    const status = which === 'active' ? 1 : 2;
    return mapAttendances(await this.get(session, `/student/attendances?status=${status}`));
  }

  async sessions(session: SiasbSession, from: Date, to: Date): Promise<ClinicalSession[]> {
    const path = `/student/schedule/sessions?startAt=${siasbDateTime(from)}&endAt=${siasbDateTime(to)}`;
    return mapSessions(await this.get(session, path));
  }

  /** Catálogo inteiro; a busca por texto é do leitor (nenhum texto livre vai na URL). */
  async procedures(session: SiasbSession, attendanceId: string): Promise<Procedure[]> {
    return mapProcedures(await this.get(session, `/student/options?kind=procedures&attendanceId=${attendanceId}`));
  }

  /** Quantos pacientes sem responsável existem, por disciplina. A lista (com nomes de terceiros) nunca sai daqui. */
  async unassignedCount(session: SiasbSession): Promise<Record<string, number>> {
    const path = '/student/unassigned-attendances';
    if (!isAllowed(path, COUNT_ONLY)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
    const res = await this.getWithRetry(path, session);
    return countUnassigned(await this.readJson(res));
  }

  /** Professores, locais e grupos permitidos para agendar neste atendimento (três leituras, só GET). */
  async schedulingOptions(session: SiasbSession, attendanceId: string): Promise<SchedulingOptions> {
    const of = (kind: string) => `/student/options?kind=${kind}&attendanceId=${attendanceId}`;
    this.requireDigits(attendanceId);
    const professors = mapSchedulingOptions(await this.get(session, of('professors')));
    const locations = mapSchedulingOptions(await this.get(session, of('ambulatoryLocations')));
    const groups = mapSchedulingOptions(await this.get(session, of('patientGroups')));
    return { professors, locations, groups };
  }

  async scheduleSessions(session: SiasbSession, input: ScheduleSessionsInput): Promise<WriteResult> {
    this.requireDigits(input.attendanceId, input.professorId, input.locationId, input.groupId);
    return this.write(session, 'POST', '/student/schedule/sessions', {
      sessionId: null,
      attendanceId: Number(input.attendanceId),
      professorId: Number(input.professorId),
      ambulatoryLocationId: Number(input.locationId),
      patientGroupId: Number(input.groupId),
      startAt: siasbDateTimeSeconds(input.startAt),
      endAt: siasbDateTimeSeconds(input.endAt),
      sessionCount: input.count,
      description: input.description,
      reason: '',
      requestsRescheduling: false,
    });
  }

  async unscheduleSession(session: SiasbSession, sessionId: string, reason: string): Promise<WriteResult> {
    // `absence` é sempre false: marcar falta nunca sai daqui.
    return this.write(session, 'POST', `/student/schedule/sessions/${sessionId}/disposition`, {
      reason,
      absence: false,
    });
  }

  async addProcedure(
    session: SiasbSession,
    attendanceId: string,
    i: { serviceId: number; teeth: string; faces: string; observation: string },
  ): Promise<WriteResult> {
    return this.write(session, 'POST', `/student/attendances/${attendanceId}/procedures`, {
      serviceId: i.serviceId,
      teeth: i.teeth,
      faces: i.faces,
      observation: i.observation,
    });
  }

  async removeProcedure(session: SiasbSession, attendanceId: string, procedureId: string): Promise<WriteResult> {
    return this.write(session, 'DELETE', `/student/attendances/${attendanceId}/procedures/${procedureId}`);
  }

  private requireDigits(...values: string[]): void {
    for (const v of values) if (!/^\d{1,12}$/.test(v)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
  }

  /**
   * Única porta de escrita. Sem retry (repetir pode duplicar a operação). Mensagens fixas: o corpo da resposta
   * (pode ter dado de paciente) nunca vira texto de erro, salvo as duas mensagens conhecidas da grade, se exatas.
   */
  private async write(session: SiasbSession, method: string, path: string, body?: unknown): Promise<WriteResult> {
    if (!isWriteAllowed(method, path)) fail('FORBIDDEN_ROUTE', 'Rota não permitida.');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookieHeader(session),
    };
    let res: Response;
    try {
      res = await this.send(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail('WRITE_UNKNOWN', UNKNOWN_WRITE);
    }
    if (res.status === 401 || res.status === 403) {
      discard(res);
      fail('REAUTH_NEEDED', 'A sessão do SIASB expirou. Conecte de novo.');
    }
    if (mergeCookies(session, readSetCookies(res))) session.dirty = true;
    if (res.status >= 500 || (res.status >= 300 && res.status < 400)) {
      discard(res);
      fail('WRITE_UNKNOWN', UNKNOWN_WRITE);
    }
    if (res.status >= 400) {
      const parsed = await this.tryText(res);
      fail('WRITE_REJECTED', KNOWN_REJECTIONS.has(parsed) ? parsed : 'O SIASB recusou a operação.');
    }
    return { ok: true, createdId: await this.createdId(res) };
  }

  /** Texto da mensagem de recusa (corpo puro, string JSON ou `message`), ou '' se não der. */
  private async tryText(res: Response): Promise<string> {
    let raw: string;
    try {
      raw = (await res.text()).trim();
    } catch {
      return '';
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (typeof parsed === 'string') return parsed;
    const m = (parsed as { message?: unknown } | null)?.message;
    return typeof m === 'string' ? m : '';
  }

  /** `id` só se for inteiro ou texto de dígitos; qualquer outra coisa é null. */
  private async createdId(res: Response): Promise<string | null> {
    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      return null;
    }
    const asId = (v: unknown): string | null => {
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
      if (typeof v === 'string' && /^\d{1,18}$/.test(v)) return v;
      return null;
    };
    if (body !== null && typeof body === 'object') {
      const o = body as { id?: unknown; procedureId?: unknown; data?: unknown };
      const data = o.data !== null && typeof o.data === 'object' ? (o.data as { id?: unknown }) : null;
      return asId(o.id) ?? asId(o.procedureId) ?? asId(data?.id) ?? null;
    }
    return asId(body);
  }

  private async getWithRetry(path: string, session: SiasbSession | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (session) headers.Cookie = cookieHeader(session);

    let last: SiasbError | null = null;
    for (let attempt = 0; attempt <= GET_RETRIES; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
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
        discard(res);
        last = new SiasbError('UNAVAILABLE', 'O SIASB está indisponível.');
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        discard(res);
        fail('REAUTH_NEEDED', 'A sessão do SIASB expirou. Conecte de novo.');
      }
      if (res.status === 429 || (res.status >= 300 && res.status < 400)) {
        discard(res);
        fail('UNAVAILABLE', 'O SIASB está indisponível.');
      }
      if (!res.ok) {
        discard(res);
        fail('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
      }
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
        // Nunca segue redirect: um 307/308 reenviaria o corpo do login (com a senha) para outro host.
        redirect: 'error',
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
