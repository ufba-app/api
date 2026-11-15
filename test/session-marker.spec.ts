import type { Response } from 'express';
import {
  clearSessionCookie,
  clearSignedInMarker,
  markerDomain,
  setSessionCookie,
  setSignedInMarker,
  SIGNED_IN_MARKER,
} from '../src/interface/web/web-auth';
import { ApiErrorFilter } from '../src/interface/web/api-error.filter';
import { sessionExpired, ApiError } from '../src/application/web/web-api';

/** Cookie marcador `ufba_signed_in`: só diz "há sessão" ao que fica na frente do painel; não autentica nada. */
describe('cookie marcador de sessão', () => {
  const keys = ['WEB_ORIGIN', 'AUTH_ORIGIN', 'PUBLIC_URL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const prod = () => {
    process.env.WEB_ORIGIN = 'https://meu.ufba.app';
    process.env.AUTH_ORIGIN = 'https://auth.ufba.app';
    process.env.PUBLIC_URL = 'https://api.ufba.app';
  };
  const fakeRes = () => {
    const cookies: string[] = [];
    const res = { append: (_h: string, v: string) => void cookies.push(v) } as unknown as Response;
    return { res, cookies };
  };

  it('em produção: Domain vem da config (.ufba.app), Secure, HttpOnly, Lax, Max-Age da sessão', () => {
    prod();
    expect(markerDomain()).toBe('.ufba.app');
    const { res, cookies } = fakeRes();
    setSignedInMarker(res, 30 * 24 * 3600 * 1000);
    expect(cookies).toEqual([`${SIGNED_IN_MARKER}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Domain=.ufba.app; Secure`]);
  });

  it('o domínio acompanha a config: na transição (ufba.app na lista) segue .ufba.app; outro domínio, outro valor', () => {
    prod();
    process.env.WEB_ORIGIN = 'https://meu.ufba.app,https://ufba.app';
    expect(markerDomain()).toBe('.ufba.app');
    process.env.WEB_ORIGIN = 'https://painel.exemplo.org';
    process.env.AUTH_ORIGIN = 'https://auth.exemplo.org';
    process.env.PUBLIC_URL = 'https://api.exemplo.org';
    expect(markerDomain()).toBe('.exemplo.org');
  });

  it('sem sufixo comum (sites diferentes), localhost ou IP: sem Domain', () => {
    prod();
    process.env.PUBLIC_URL = 'https://api.outro.dev';
    expect(markerDomain()).toBeNull();
    process.env.WEB_ORIGIN = 'http://localhost:3001';
    process.env.AUTH_ORIGIN = 'http://localhost:3002';
    process.env.PUBLIC_URL = 'http://localhost:3000';
    expect(markerDomain()).toBeNull();
    process.env.WEB_ORIGIN = 'http://127.0.0.1:3001';
    process.env.AUTH_ORIGIN = 'http://127.0.0.1:3002';
    process.env.PUBLIC_URL = 'http://127.0.0.1:3000';
    expect(markerDomain()).toBeNull();
  });

  it('em dev (http localhost): sem Secure e sem Domain', () => {
    process.env.WEB_ORIGIN = 'http://localhost:3001';
    process.env.AUTH_ORIGIN = 'http://localhost:3002';
    process.env.PUBLIC_URL = 'http://localhost:3000';
    const { res, cookies } = fakeRes();
    setSessionCookie(res, 'tok.K', 60_000);
    expect(cookies).toEqual([
      'ufba_session=tok.K; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
      'ufba_signed_in=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
    ]);
  });

  it('sessão: o cookie de sessão segue sem Domain e o marcador sai junto, com o mesmo Max-Age', () => {
    prod();
    const { res, cookies } = fakeRes();
    setSessionCookie(res, 'tok.K', 3_600_000);
    expect(cookies[0]).toBe('__Host-ufba_session=tok.K; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure');
    expect(cookies[0]).not.toContain('Domain');
    expect(cookies[1]).toBe('ufba_signed_in=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Domain=.ufba.app; Secure');
    expect(cookies[1]).not.toContain('tok');
  });

  it('apagar: Max-Age=0 com o mesmo Domain e Path (senão o navegador não apaga)', () => {
    prod();
    const a = fakeRes();
    clearSessionCookie(a.res);
    expect(a.cookies).toEqual([
      '__Host-ufba_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
      'ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Domain=.ufba.app; Secure',
    ]);
    const b = fakeRes();
    clearSignedInMarker(b.res);
    expect(b.cookies).toEqual(['ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Domain=.ufba.app; Secure']);
  });

  describe('401 session_expired', () => {
    const run = (e: unknown) => {
      const cookies: string[] = [];
      const res = {
        headersSent: false,
        append(_h: string, v: string) {
          cookies.push(v);
          return this;
        },
        status() {
          return this;
        },
        setHeader() {
          return this;
        },
        json() {
          return this;
        },
      };
      new ApiErrorFilter().catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as never);
      return cookies;
    };

    it('apaga o marcador quando a API devolve 401 session_expired', () => {
      prod();
      expect(run(sessionExpired())).toEqual(['ufba_signed_in=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Domain=.ufba.app; Secure']);
    });

    it('não mexe no marcador em outros erros', () => {
      prod();
      expect(run(new ApiError(403, 'csrf_rejected', 'x'))).toEqual([]);
      expect(run(new ApiError(404, 'not_found', 'x'))).toEqual([]);
    });
  });
});
