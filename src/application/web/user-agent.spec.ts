import { parseUserAgent } from './user-agent';

const UA = {
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
  operaWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 OPR/120.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.8103.50 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 16; SM-S942B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.50 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 17; SM-A576B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/157.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:160.0) Gecko/20100101 Firefox/160.0',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
};

describe('parseUserAgent', () => {
  it.each([
    ['firefoxWin', 'Firefox 160', 'Windows'],
    ['chromeWin', 'Chrome 157', 'Windows'],
    ['edgeWin', 'Edge 157', 'Windows'],
    ['operaWin', 'Opera 120', 'Windows'],
    ['safariMac', 'Safari 18', 'macOS'],
    ['safariIphone', 'Safari 26', 'iOS'],
    ['chromeIphone', 'Chrome 157', 'iOS'],
    ['chromeAndroid', 'Chrome 157', 'Android'],
    ['samsung', 'Samsung Internet 30', 'Android'],
    ['firefoxLinux', 'Firefox 160', 'Linux'],
    ['chromeOs', 'Chrome 157', 'ChromeOS'],
  ] as const)('%s', (key, browser, os) => {
    expect(parseUserAgent(UA[key])).toEqual({ browser, os });
  });

  it('sem User-Agent ou irreconhecível: nulos (a tela mostra só o horário)', () => {
    expect(parseUserAgent(undefined)).toEqual({ browser: null, os: null });
    expect(parseUserAgent('')).toEqual({ browser: null, os: null });
    expect(parseUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null });
  });

  it('limita o tamanho lido (cabeçalho gigante)', () => {
    expect(parseUserAgent('x'.repeat(100_000) + UA.firefoxWin)).toEqual({ browser: null, os: null });
  });
});
