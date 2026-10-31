import { createHash } from 'node:crypto';
import {
  buildLaunchUrl,
  extractReturnedToken,
  newPassport,
  parseReturnedToken,
  verifyPassport,
} from './token-launch';

const SITE = 'https://moodle.test';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('token-launch', () => {
  it('newPassport gera valores distintos', () => {
    const a = newPassport();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(newPassport()).not.toBe(a);
  });

  it('buildLaunchUrl monta a URL do launch.php', () => {
    const url = new URL(buildLaunchUrl(`${SITE}/`, 'abc', 'ufba-app'));
    expect(url.origin + url.pathname).toBe(`${SITE}/admin/tool/mobile/launch.php`);
    expect(url.searchParams.get('service')).toBe('moodle_mobile_app');
    expect(url.searchParams.get('passport')).toBe('abc');
    expect(url.searchParams.get('urlscheme')).toBe('ufba-app');
  });

  it('parseReturnedToken lê assinatura, wstoken e privatetoken', () => {
    expect(parseReturnedToken(b64('sig:::tok:::priv'))).toEqual({
      signature: 'sig',
      wstoken: 'tok',
      privatetoken: 'priv',
    });
    expect(parseReturnedToken(b64('sig:::tok')).privatetoken).toBeUndefined();
  });

  it('parseReturnedToken rejeita formato inesperado', () => {
    expect(() => parseReturnedToken(b64('so-um-campo'))).toThrow(/formato inesperado/);
    expect(() => parseReturnedToken(b64('sig:::'))).toThrow();
  });

  it('extractReturnedToken acha token em scheme://, query e fragmento', () => {
    const t = encodeURIComponent('YWJj/+=');
    expect(extractReturnedToken(`ufba-app://token=${t}`)).toBe('YWJj/+=');
    expect(extractReturnedToken(`https://x.test/cb?a=1&token=${t}`)).toBe('YWJj/+=');
    expect(extractReturnedToken(`https://x.test/cb#token=${t}`)).toBe('YWJj/+=');
    expect(extractReturnedToken('ufba-app://nada')).toBeUndefined();
  });

  it('verifyPassport aceita md5(siteUrl+passport) e rejeita o resto', () => {
    const sig = md5(SITE + 'p1');
    expect(verifyPassport(sig, SITE, 'p1')).toBe(true);
    expect(verifyPassport(sig, SITE, 'p2')).toBe(false);
    expect(verifyPassport(sig, 'https://outro.test', 'p1')).toBe(false);
    expect(verifyPassport('curto', SITE, 'p1')).toBe(false);
  });

  it('fluxo completo: retorno → token verificado', () => {
    const passport = newPassport();
    const returned = `ufba-app://token=${encodeURIComponent(b64(`${md5(SITE + passport)}:::WSTOKEN`))}`;
    const parsed = parseReturnedToken(extractReturnedToken(returned)!);
    expect(verifyPassport(parsed.signature, SITE, passport)).toBe(true);
    expect(parsed.wstoken).toBe('WSTOKEN');
  });
});
