import type { SourceContext } from './source-types';

export type FetchFn = typeof fetch;

export class MoodleError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

/** Remove o token de qualquer texto antes de virar mensagem de erro. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

/** Cliente fino da Web Service REST do Moodle (POST /webservice/rest/server.php). */
export class MoodleClient {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async call<T>(
    ctx: SourceContext,
    wsfunction: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const body = new URLSearchParams({
      wstoken: ctx.token,
      wsfunction,
      moodlewsrestformat: 'json',
    });
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));

    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/webservice/rest/server.php`;
    const res = await this.fetchFn(url, { method: 'POST', body });
    if (!res.ok) {
      throw new MoodleError(`Moodle HTTP ${res.status} em ${wsfunction}`);
    }
    const json: unknown = await res.json();
    if (json && typeof json === 'object' && 'exception' in json) {
      const e = json as { errorcode?: string; message?: string };
      throw new MoodleError(
        scrub(`Moodle ${wsfunction}: ${e.message ?? 'erro'}`, ctx.token),
        e.errorcode,
      );
    }
    return json as T;
  }
}
