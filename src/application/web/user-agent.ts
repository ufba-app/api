export interface SeenClient {
  /** "Firefox 160", "Chrome 157", "Safari 18"; `null` se o User-Agent não diz. */
  browser: string | null;
  /** "Windows", "macOS", "Linux", "Android", "iOS", "ChromeOS"; `null` se não diz. */
  os: string | null;
}

const major = (ua: string, re: RegExp): string | null => {
  const m = re.exec(ua);
  return m ? m[1].split('.')[0] : null;
};

/**
 * Navegador e sistema que o cabeçalho User-Agent diz. É o que a API VÊ (e grava) ao receber o pedido do QR, para o celular
 * mostrar antes de pedir a digital em vez do rótulo que o computador escreveu. O User-Agent também pode ser forjado por
 * quem controla o computador, mas é o que a API enxerga, e é melhor que um texto livre; a tela também mostra o horário.
 * Ordem importa: Edge, Opera e Samsung contêm "Chrome"; o Chrome do iOS é "CriOS"; o Safari não contém "Chrome".
 */
export function parseUserAgent(ua: string | undefined | null): SeenClient {
  const text = (ua ?? '').slice(0, 512);
  if (!text) return { browser: null, os: null };

  const pick = (name: string, version: string | null) => (version ? `${name} ${version}` : name);
  let browser: string | null = null;
  const edge = major(text, /\bEdg(?:e|A|iOS)?\/(\d+[\d.]*)/);
  const opera = major(text, /\bOPR\/(\d+[\d.]*)/);
  const samsung = major(text, /\bSamsungBrowser\/(\d+[\d.]*)/);
  const firefox = major(text, /\b(?:Firefox|FxiOS)\/(\d+[\d.]*)/);
  const chrome = major(text, /\b(?:Chrome|CriOS)\/(\d+[\d.]*)/);
  const safari = /\bSafari\//.test(text) ? major(text, /\bVersion\/(\d+[\d.]*)/) : null;
  if (edge) browser = pick('Edge', edge);
  else if (opera) browser = pick('Opera', opera);
  else if (samsung) browser = pick('Samsung Internet', samsung);
  else if (firefox) browser = pick('Firefox', firefox);
  else if (chrome) browser = pick('Chrome', chrome);
  else if (/\bSafari\//.test(text)) browser = pick('Safari', safari);

  let os: string | null = null;
  if (/\bWindows\b/.test(text)) os = 'Windows';
  else if (/\bAndroid\b/.test(text)) os = 'Android';
  else if (/\b(iPhone|iPad|iPod)\b/.test(text)) os = 'iOS';
  else if (/\bCrOS\b/.test(text)) os = 'ChromeOS';
  else if (/\bMacintosh\b|\bMac OS X\b/.test(text)) os = 'macOS';
  else if (/\bLinux\b|\bX11\b/.test(text)) os = 'Linux';

  return { browser, os };
}
