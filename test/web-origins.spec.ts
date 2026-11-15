import type { Request } from 'express';
import { ConnectionsService } from '../src/application/web/connections.service';
import { checkCsrf, validateOriginConfig, webEnv } from '../src/interface/web/web-auth';

/** `WEB_ORIGIN` como lista (transição entre domínios do painel): a primeira é a principal, todas valem para CORS/CSRF. */
describe('origens do painel', () => {
  const saved = { web: process.env.WEB_ORIGIN, auth: process.env.AUTH_ORIGIN, pub: process.env.PUBLIC_URL };
  afterEach(() => {
    for (const [k, v] of [['WEB_ORIGIN', saved.web], ['AUTH_ORIGIN', saved.auth], ['PUBLIC_URL', saved.pub]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const NOVA = 'https://meu.ufba.app';
  const ANTIGA = 'https://ufba.app';
  const AUTH = 'https://auth.ufba.app';

  it('a primeira é a principal; todas (e a do auth) entram em origins; um valor só segue igual', () => {
    process.env.WEB_ORIGIN = `${NOVA},${ANTIGA}`;
    process.env.AUTH_ORIGIN = AUTH;
    const e = webEnv();
    expect(e.webOrigin).toBe(NOVA);
    expect(e.webOrigins).toEqual([NOVA, ANTIGA]);
    expect(e.origins).toEqual([NOVA, ANTIGA, AUTH]);
    expect(e.authOrigin).toBe(AUTH);

    process.env.WEB_ORIGIN = ANTIGA;
    expect(webEnv().webOrigin).toBe(ANTIGA);
    expect(webEnv().origins).toEqual([ANTIGA, AUTH]);
  });

  it('sem AUTH_ORIGIN, o auth é a origem principal do painel', () => {
    process.env.WEB_ORIGIN = `${NOVA}, ${ANTIGA}`;
    delete process.env.AUTH_ORIGIN;
    const e = webEnv();
    expect(e.authOrigin).toBe(NOVA);
    expect(e.origins).toEqual([NOVA, ANTIGA]);
  });

  it('CSRF aceita Origin de qualquer origem da lista e recusa as outras', () => {
    process.env.WEB_ORIGIN = `${NOVA},${ANTIGA}`;
    process.env.AUTH_ORIGIN = AUTH;
    const post = (origin: string) =>
      ({ method: 'POST', headers: { origin, 'x-ufba': '1', 'content-type': 'application/json' } }) as unknown as Request;
    for (const ok of [NOVA, ANTIGA, AUTH]) expect(() => checkCsrf(post(ok))).not.toThrow();
    expect(() => checkCsrf(post('https://evil.example'))).toThrow();
    expect(() => checkCsrf(post('https://outro.ufba.app'))).toThrow();
  });

  it('o redirect da API para o painel (volta do Classroom) usa a origem principal', async () => {
    process.env.WEB_ORIGIN = `${NOVA},${ANTIGA}`;
    const svc = new ConnectionsService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      { webOrigin: webEnv().webOrigin, institutionalDomain: 'ufba.br' },
    );
    const to = await svc.classroomCallback({ state: 'web.desconhecido' }, undefined, 'https://api.ufba.app');
    const u = new URL(to);
    expect(`${u.origin}${u.pathname}`).toBe(`${NOVA}/connections`);
    expect(u.searchParams.get('error')).toBe('invalid_request');
  });

  describe('validateOriginConfig (boot)', () => {
    const run = (env: Record<string, string>, production = true) => () =>
      validateOriginConfig(env as NodeJS.ProcessEnv, production);

    it('aceita lista https em produção, com AUTH_ORIGIN único', () => {
      expect(run({ WEB_ORIGIN: `${NOVA},${ANTIGA}`, AUTH_ORIGIN: AUTH })).not.toThrow();
      expect(run({ WEB_ORIGIN: NOVA })).not.toThrow();
    });
    it('em desenvolvimento aceita http', () => {
      expect(run({ WEB_ORIGIN: 'http://localhost:3001', AUTH_ORIGIN: 'http://localhost:3002' }, false)).not.toThrow();
    });
    it('recusa http em produção (em qualquer item)', () => {
      expect(run({ WEB_ORIGIN: 'http://meu.ufba.app' })).toThrow(/https/);
      expect(run({ WEB_ORIGIN: `${NOVA},http://ufba.app` })).toThrow(/https/);
      expect(run({ WEB_ORIGIN: NOVA, AUTH_ORIGIN: 'http://auth.ufba.app' })).toThrow(/https/);
    });
    it('recusa barra final, curinga, caminho e item vazio', () => {
      expect(run({ WEB_ORIGIN: `${NOVA}/` })).toThrow(/barra final/);
      expect(run({ WEB_ORIGIN: `${NOVA},${ANTIGA}/` })).toThrow(/barra final/);
      expect(run({ WEB_ORIGIN: 'https://*.ufba.app' })).toThrow(/curinga/);
      expect(run({ WEB_ORIGIN: '*' })).toThrow(/curinga/);
      expect(run({ WEB_ORIGIN: `${NOVA}/painel` })).toThrow(/só a origem/);
      expect(run({ WEB_ORIGIN: `${NOVA},` })).toThrow(/vazio/);
      expect(run({ WEB_ORIGIN: 'meu.ufba.app' })).toThrow(/inválida/);
    });
    it('AUTH_ORIGIN é único e sem curinga', () => {
      expect(run({ WEB_ORIGIN: NOVA, AUTH_ORIGIN: `${AUTH},${NOVA}` })).toThrow(/uma origem só/);
      expect(run({ WEB_ORIGIN: NOVA, AUTH_ORIGIN: 'https://*.ufba.app' })).toThrow(/curinga/);
      expect(run({ WEB_ORIGIN: NOVA, AUTH_ORIGIN: `${AUTH}/` })).toThrow(/barra final/);
    });
  });
});
