import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Funções puras do SSO do Moodle (`admin/tool/mobile/launch.php`), portadas de `mobile/src/lib/moodle-auth.ts`
 * do app antigo. O usuário nunca cola o token: a tela abre `buildLaunchUrl`, o login institucional (CAFe)
 * acontece no Moodle e o redirect `<scheme>://token=<base64>` é capturado automaticamente.
 * Aqui não há rede nem navegador: só montar a URL, interpretar o retorno e conferir a assinatura.
 */

export interface ParsedMoodleToken {
  signature: string;
  wstoken: string;
  privatetoken?: string;
}

/** Um passport novo por tentativa de login. Aleatório e imprevisível (o app antigo usava Math.random). */
export function newPassport(): string {
  return randomBytes(12).toString('hex');
}

/** URL que inicia o SSO. `urlScheme` é o esquema do redirect final (ver docs/MOODLE.md, dúvida do spike). */
export function buildLaunchUrl(
  siteUrl: string,
  passport: string,
  urlScheme: string,
): string {
  const params = new URLSearchParams({
    service: 'moodle_mobile_app',
    passport,
    urlscheme: urlScheme,
  });
  return `${siteUrl.replace(/\/+$/, '')}/admin/tool/mobile/launch.php?${params.toString()}`;
}

/** Extrai o valor base64 de `token=` de uma URL de retorno (query, fragmento ou `scheme://token=...`). */
export function extractReturnedToken(returnedUrl: string): string | undefined {
  const match = /[?&#]token=([^&]+)/.exec(returnedUrl) ?? /token=([^&]+)/.exec(returnedUrl);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** Decodifica `<assinatura>:::<wstoken>[:::<privatetoken>]` (base64). */
export function parseReturnedToken(base64: string): ParsedMoodleToken {
  const parts = Buffer.from(base64, 'base64').toString('utf-8').split(':::');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('Resposta de token do Moodle em formato inesperado');
  }
  return {
    signature: parts[0],
    wstoken: parts[1],
    privatetoken: parts[2] || undefined,
  };
}

/**
 * Confere a assinatura: o Moodle devolve md5(siteUrl + passport). Rodar ANTES de confiar no token.
 * `siteUrl` deve ser exatamente o que o Moodle usa no cálculo (o app antigo usava `https://ava.ufba.br`, sem barra).
 * md5 aqui é só verificação de integridade do protocolo do Moodle, não proteção de segredo.
 */
export function verifyPassport(
  signature: string,
  siteUrl: string,
  passport: string,
): boolean {
  const expected = createHash('md5').update(siteUrl + passport).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
