/** Auxiliar de testes: fetch simulado por substring de URL. Sem rede. */
export type Route = { match: string; body: unknown | (() => unknown); status?: number; raw?: Uint8Array };

export function fakeFetch(routes: Route[]): jest.Mock {
  return jest.fn(async (input: URL | string) => {
    const url = String(input);
    const r = routes.find((x) => url.includes(x.match));
    if (!r) return new Response('not found', { status: 404 });
    const status = r.status ?? 200;
    if (r.raw) return new Response(Buffer.from(r.raw), { status });
    const body = typeof r.body === 'function' ? (r.body as () => unknown)() : r.body;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

export const tokenRoute: Route = {
  match: 'oauth2.googleapis.com/token',
  body: { access_token: 'AT', expires_in: 3600 },
};
