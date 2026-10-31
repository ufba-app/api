#!/usr/bin/env node
/**
 * SPIKE: o SERVIDOR consegue fazer o SSO (CAFe/Shibboleth) do Moodle com usuário e senha recebidos por requisição
 * e ler o header `Location: moodlemobile://token=<b64>` do launch.php, sem seguir esse último redirect?
 *
 * Sem dependências novas: `fetch` do Node, cookie jar manual e redirects manuais.
 * A senha vem só de variável de ambiente, fica em memória e NUNCA é impressa nem gravada. Também nunca se imprime
 * cookie, HTML, query string de URL (carrega SAMLRequest/RelayState) ou token inteiro: só o passo atingido e o
 * resultado, com o token mascarado. Nada é gravado em disco.
 *
 * Pré-requisito: `npm run build` (reaproveita parseReturnedToken/verifyPassport de token-launch.ts via dist/).
 *
 * Uso (bash):
 *   MOODLE_USER=... MOODLE_PASSWORD=... node scripts/moodle-sso-spike.mjs
 *   opções: --site https://ava.ufba.br   --verbose (lista cada salto como host+caminho)
 *
 * Se esbarrar em captcha, JS obrigatório, segundo fator ou página inesperada, PARA e diz em qual passo e por quê.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SITE = opt('site', process.env.MOODLE_SITE ?? 'https://ava.ufba.br').replace(/\/+$/, '');
const VERBOSE = args.includes('--verbose');
const USER = process.env.MOODLE_USER;
const PASSWORD = process.env.MOODLE_PASSWORD;
const UA = 'Mozilla/5.0 (compatible; platform-moodle-spike)';
const MAX_HOPS = 40;

// ---------- saída segura ----------
let step = '0 (início)';
const say = (m) => console.log(m);
const mask = (s) => (s.length <= 8 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)} (${s.length} chars)`);
/** host+caminho, sem query nem fragmento. */
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return '(url inválida)';
  }
};
function stop(reason, code = 1) {
  say(`\nPARADO no passo ${step}.\nMotivo: ${reason}`);
  process.exit(code);
}

if (!USER || !PASSWORD) {
  console.error('Defina MOODLE_USER e MOODLE_PASSWORD no ambiente (a senha não é aceita por argumento).');
  process.exit(2);
}

// ---------- reaproveita as funções do projeto ----------
const distFile = resolve('dist/src/infrastructure/sources/moodle/token-launch.js');
if (!existsSync(distFile)) {
  console.error('Rode `npm run build` antes (o script usa dist/.../token-launch.js).');
  process.exit(2);
}
const mod = await import(pathToFileURL(distFile).href);
const { parseReturnedToken, verifyPassport } = mod.default ?? mod;

// ---------- cookie jar manual ----------
/** @type {Array<{domain:string,name:string,value:string}>} */
let jar = [];
function storeCookies(res, url) {
  const host = new URL(url).hostname;
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    let domain = host;
    let expired = false;
    for (const a of attrs) {
      const [k, v = ''] = a.split('=');
      if (/^domain$/i.test(k)) domain = v.replace(/^\./, '').toLowerCase();
      if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
      if (/^expires$/i.test(k) && Date.parse(v) < Date.now()) expired = true;
    }
    jar = jar.filter((c) => !(c.domain === domain && c.name === name));
    if (!expired && value !== '') jar.push({ domain, name, value });
  }
}
function cookieHeader(url) {
  const host = new URL(url).hostname.toLowerCase();
  return jar
    .filter((c) => host === c.domain || host.endsWith(`.${c.domain}`))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// ---------- HTTP com redirect manual ----------
const isHttp = (u) => /^https?:/i.test(u);

/**
 * Faz a requisição e segue redirects HTTP à mão. Para quando o Location não é http(s) (esquema do app) e o devolve.
 * @returns {{ url:string, status:number, body:string, appLocation?:string }}
 */
async function go(method, url, form, referer) {
  let m = method;
  let u = url;
  let body = form;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'pt-BR,pt;q=0.9' };
    const c = cookieHeader(u);
    if (c) headers.cookie = c;
    if (referer) headers.referer = referer;
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    let res;
    try {
      res = await fetch(u, { method: m, headers, body: body?.toString(), redirect: 'manual' });
    } catch (e) {
      stop(`falha de rede em ${safeUrl(u)}: ${e?.cause?.code ?? e?.message ?? 'erro'}`);
    }
    storeCookies(res, u);
    if (VERBOSE) say(`  ${m} ${safeUrl(u)} -> ${res.status}`);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (!isHttp(loc) && !loc.startsWith('/') && /^[a-z][a-z0-9+.-]*:/i.test(loc)) {
        return { url: u, status: res.status, body: '', appLocation: loc };
      }
      referer = u;
      u = new URL(loc, u).toString();
      // 301/302/303 viram GET; 307/308 manteriam método, mas o SSO usa só 302/303.
      if (res.status !== 307 && res.status !== 308) {
        m = 'GET';
        body = undefined;
      }
      continue;
    }
    return { url: u, status: res.status, body: await res.text() };
  }
  stop(`mais de ${MAX_HOPS} redirects seguidos (possível laço)`);
}

// ---------- parsing mínimo de HTML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}
function parseForms(html) {
  const forms = [];
  for (const f of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const a = attrs(f[1]);
    const fields = [];
    for (const i of f[2].matchAll(/<input\b([^>]*)>/gi)) {
      const x = attrs(i[1]);
      if (x.name) fields.push({ name: x.name, type: (x.type ?? 'text').toLowerCase(), value: x.value ?? '' });
    }
    for (const b of f[2].matchAll(/<button\b([^>]*)>/gi)) {
      const x = attrs(b[1]);
      if (x.name) fields.push({ name: x.name, type: 'submit', value: x.value ?? '' });
    }
    forms.push({ action: a.action ?? '', method: (a.method ?? 'get').toUpperCase(), fields });
  }
  return forms;
}
const hasPassword = (f) => f.fields.some((x) => x.type === 'password');
const CAPTCHA = /g-recaptcha|recaptcha|hcaptcha|h-captcha|cf-turnstile|captcha/i;
const MFA_TEXT = /segundo fator|dois fatores|two[- ]factor|verification code|c[oó]digo de verifica|authenticator|autenticador|one[- ]time (code|password)|\botp\b/i;
const MFA_FIELD = /otp|totp|mfa|2fa|verification|verificationcode|authcode|token_code/i;

/** Para o fluxo se a página mostra captcha ou segundo fator. */
function checkObstacles(html, forms) {
  if (CAPTCHA.test(html)) stop(`a página (${safeUrl(lastUrl)}) contém captcha; o servidor não consegue resolver`);
  const mfaField = forms.some((f) => !hasPassword(f) && f.fields.some((x) => x.type !== 'hidden' && x.type !== 'submit' && MFA_FIELD.test(x.name)));
  if (mfaField || MFA_TEXT.test(html)) stop(`a página (${safeUrl(lastUrl)}) pede segundo fator (código/OTP); precisa de interação humana`);
}

let lastUrl = SITE;
const toBody = (fields, overrides = {}, submit) => {
  const p = new URLSearchParams();
  for (const f of fields) {
    if (f.type === 'submit' || f.type === 'button' || f.type === 'image') continue;
    if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
    p.set(f.name, f.name in overrides ? overrides[f.name] : f.value);
  }
  for (const [k, v] of Object.entries(overrides)) p.set(k, v);
  if (submit) p.set(submit.name, submit.value);
  return p;
};

// ---------- fluxo ----------
const passport = randomBytes(12).toString('hex');
const launch = `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;

step = '1 (GET launch.php)';
say(`Passo 1: GET ${safeUrl(launch)} (passport novo, urlscheme=moodlemobile)`);
let r = await go('GET', launch);
let loginDone = false;
let sawIdp = false;

for (let turn = 0; turn < 12 && !r.appLocation; turn++) {
  lastUrl = r.url;
  const host = new URL(r.url).hostname;
  if (/cafe\.ufba\.br$/i.test(host)) sawIdp = true;

  // O token pode vir num corpo intermediário (meta refresh / link / JS) em vez de um 302.
  const inBody = /moodlemobile:\/\/token=[^"'\s<>&]+/i.exec(r.body);
  if (inBody) {
    r.appLocation = decodeURIComponent(inBody[0]);
    say(`  (token veio no corpo da página ${safeUrl(r.url)}, não em header Location)`);
    break;
  }

  const forms = parseForms(r.body);
  checkObstacles(r.body, forms);

  const loginForm = forms.find(hasPassword);
  if (loginForm) {
    if (loginDone) {
      step = `4 (login em ${safeUrl(r.url)})`;
      stop('o formulário de login voltou depois do envio: usuário/senha rejeitados, ou o IdP exige algo mais (não dá para saber qual sem ver a página)');
    }
    step = `3 (formulário de login em ${safeUrl(r.url)})`;
    const user = loginForm.fields.find((x) => ['text', 'email'].includes(x.type) && /user|login|mail|cpf|ident/i.test(x.name)) ?? loginForm.fields.find((x) => x.type === 'text');
    const pass = loginForm.fields.find((x) => x.type === 'password');
    if (!user) stop('formulário de login sem campo de usuário reconhecível (campos: ' + loginForm.fields.map((x) => `${x.name}:${x.type}`).join(', ') + ')');
    say(`Passo 3: formulário de login em ${safeUrl(r.url)} (campos: ${loginForm.fields.map((x) => `${x.name}:${x.type}`).join(', ')}) — enviando credenciais`);
    const submit = loginForm.fields.find((x) => x.type === 'submit' && /proceed|login|entrar/i.test(`${x.name}${x.value}`)) ?? loginForm.fields.find((x) => x.type === 'submit');
    const body = toBody(loginForm.fields, { [user.name]: USER, [pass.name]: PASSWORD }, submit);
    const target = new URL(loginForm.action || r.url, r.url).toString();
    if (!isHttp(target)) stop('action do formulário de login não é http(s)');
    step = `4 (POST de login em ${safeUrl(target)})`;
    r = await go(loginForm.method === 'GET' ? 'GET' : 'POST', target, loginForm.method === 'GET' ? undefined : body, r.url);
    loginDone = true;
    continue;
  }

  // Formulário sem senha: auto-POST de SAML (SAMLRequest/SAMLResponse/RelayState) ou página de consentimento.
  const auto = forms.find((f) => f.fields.some((x) => /^SAML(Request|Response)$/.test(x.name) || x.name === 'RelayState' || x.name === '_eventId_proceed'));
  if (auto) {
    const kind = auto.fields.some((x) => x.name === 'SAMLResponse') ? 'SAMLResponse → SP do AVA' : auto.fields.some((x) => x.name === 'SAMLRequest') ? 'SAMLRequest → IdP' : 'consentimento/continuação';
    step = `${loginDone ? '4' : '2'} (formulário automático: ${kind})`;
    say(`Passo ${loginDone ? '4' : '2'}: enviando formulário automático (${kind}) para ${safeUrl(new URL(auto.action || r.url, r.url).toString())}`);
    const submit = auto.fields.find((x) => x.type === 'submit' && x.name === '_eventId_proceed');
    const target = new URL(auto.action || r.url, r.url).toString();
    r = await go(auto.method === 'GET' ? 'GET' : 'POST', target, auto.method === 'GET' ? undefined : toBody(auto.fields, {}, submit), r.url);
    continue;
  }

  // Sem formulário utilizável: tenta um link para o IdP (botão "Login CAFe"); senão, para.
  const link = [...r.body.matchAll(/<a\b([^>]*)>/gi)].map((m) => attrs(m[1]).href).find((h) => h && /shib|saml|wayf|idp|cafe/i.test(h) && !/logout/i.test(h));
  if (link && !loginDone) {
    const target = new URL(link, r.url).toString();
    step = `2 (link para o IdP em ${safeUrl(r.url)})`;
    say(`Passo 2: seguindo link de login federado ${safeUrl(target)}`);
    r = await go('GET', target, undefined, r.url);
    continue;
  }

  step = `${loginDone ? '4/5' : '2'} (página sem formulário em ${safeUrl(r.url)})`;
  const needsJs = /<script/i.test(r.body) && /document\.(forms|location)|location\.(href|replace)|\.submit\(\)/i.test(r.body);
  stop(needsJs ? `a página (${safeUrl(r.url)}) depende de JavaScript para continuar (sem formulário nem link utilizável); sem navegador o servidor não segue` : `a página (${safeUrl(r.url)}, HTTP ${r.status}) não tem formulário, link de login nem token; fluxo inesperado`);
}

if (!r.appLocation) {
  step = '5 (captura do Location)';
  stop(`o fluxo não terminou num redirect para moodlemobile:// (parou em ${safeUrl(r.url)})`);
}

step = '5 (captura do Location com o esquema do app)';
say(`Passo 5: o launch.php respondeu com redirect para o esquema do app (IdP CAFe visto: ${sawIdp ? 'sim' : 'não'})`);
const m = /token=([^&#\s]+)/.exec(r.appLocation);
if (!m) stop('Location com esquema do app, mas sem token=');
let parsed;
try {
  parsed = parseReturnedToken(decodeURIComponent(m[1]));
} catch (e) {
  stop(`token em formato inesperado: ${e.message}`);
}
const sigOk = verifyPassport(parsed.signature, SITE, passport) || verifyPassport(parsed.signature, `${SITE}/`, passport);
say(`  wstoken: ${mask(parsed.wstoken)}${parsed.privatetoken ? `, privatetoken: ${mask(parsed.privatetoken)}` : ''}`);
say(`  assinatura md5(siteUrl+passport) confere: ${sigOk ? 'SIM' : 'NÃO'}`);
if (!sigOk) stop('assinatura do passport não confere; o token não deve ser usado');

step = '6 (validação com core_webservice_get_site_info)';
const ws = await fetch(`${SITE}/webservice/rest/server.php`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
  body: new URLSearchParams({ wstoken: parsed.wstoken, wsfunction: 'core_webservice_get_site_info', moodlewsrestformat: 'json' }),
});
const info = await ws.json().catch(() => undefined);
if (!ws.ok || !info || info.exception) stop(`o token não funcionou no web service (${info?.errorcode ?? `HTTP ${ws.status}`})`);
say(`Passo 6: core_webservice_get_site_info OK — site "${info.sitename ?? '?'}", userid ${info.userid ?? '?'} (nome do usuário omitido de propósito)`);
say('\nRESULTADO: SSO feito pelo servidor FUNCIONA nesta conta (sem captcha/JS/segundo fator neste fluxo).');
