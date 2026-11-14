#!/usr/bin/env node
/**
 * SPIKE: o launch.php do Moodle (ava.ufba.br) aceita um callback http://localhost em `urlscheme`?
 *
 * Sobe um servidor em http://localhost:8787, monta a URL do launch.php com `urlscheme` apontando para
 * http://localhost:8787/cb (em variantes de codificação), e imprime o que chegar no callback e se a assinatura
 * md5(siteUrl + passport) confere. O token NUNCA é gravado em disco nem impresso por inteiro (só mascarado).
 *
 * Uso:
 *   node scripts/moodle-spike.mjs                      # variante 1
 *   node scripts/moodle-spike.mjs --variant 2          # 1..4, ver VARIANTS
 *   node scripts/moodle-spike.mjs --site https://ava.ufba.br --port 8787 --no-open
 *
 * Rode UMA variante por vez, fazendo o login CAFe no navegador que abrir.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SITE = opt('site', 'https://ava.ufba.br').replace(/\/+$/, '');
const PORT = Number(opt('port', '8787'));
const VARIANT = Number(opt('variant', '1'));
const OPEN = !args.includes('--no-open');
const TIMEOUT_MS = 5 * 60 * 1000;
const CB = `http://localhost:${PORT}/cb`;

/**
 * Valor de `urlscheme` já como vai na query (o que o Moodle recebe depois de decodificar uma vez).
 * O Moodle monta o redirect como `<urlscheme>://token=<base64>`, então esperamos chegar em `/cb://token=...`
 * ou, nas variantes com `?`/`#`, o token na query/fragmento. O script não presume qual funciona.
 */
const VARIANTS = {
  1: { desc: 'urlscheme = URL pura, codificada uma vez pela query', raw: (cb) => encodeURIComponent(cb) },
  2: { desc: 'urlscheme = URL codificada duas vezes', raw: (cb) => encodeURIComponent(encodeURIComponent(cb)) },
  3: { desc: 'urlscheme termina em "?" (token cairia na query)', raw: (cb) => encodeURIComponent(`${cb}?`) },
  4: { desc: 'urlscheme termina em "#" (token cairia no fragmento)', raw: (cb) => encodeURIComponent(`${cb}#`) },
};
if (!VARIANTS[VARIANT]) {
  console.error(`Variante inválida. Use 1..${Object.keys(VARIANTS).length}.`);
  process.exit(2);
}

const passport = randomBytes(12).toString('hex');
const launchUrl =
  `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}` +
  `&urlscheme=${VARIANTS[VARIANT].raw(CB)}`;

const mask = (s) => (s.length <= 8 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)} (${s.length} chars)`);
const md5 = (s) => createHash('md5').update(s).digest('hex');

/** Procura `token=<valor>` em um texto e devolve o valor decodificado. */
function findToken(text) {
  const m = /[?&#/:]token=([^&#\s]+)/.exec(text) ?? /token=([^&#\s]+)/.exec(text);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function analyze(label, href) {
  console.log(`\n[${label}] chegou: ${href.replace(/token=[^&#\s]+/g, (t) => `token=${mask(t.slice(6))}`)}`);
  const b64 = findToken(href);
  if (!b64) return console.log('  → nenhum token encontrado nesta chegada');
  const parts = Buffer.from(b64, 'base64').toString('utf8').split(':::');
  if (parts.length < 2 || !parts[1]) return console.log('  → token presente mas em formato inesperado (esperado sig:::wstoken[:::priv])');
  const [signature, wstoken, priv] = parts;
  // O Moodle assina com md5(wwwroot + passport); testamos com e sem barra final para descobrir o wwwroot exato.
  const okNoSlash = signature === md5(SITE + passport);
  const okSlash = signature === md5(`${SITE}/` + passport);
  console.log(`  → wstoken: ${mask(wstoken)}${priv ? `, privatetoken: ${mask(priv)}` : ''}`);
  console.log(`  → assinatura confere: ${okNoSlash || okSlash ? 'SIM' : 'NÃO'}${okSlash && !okNoSlash ? ' (wwwroot COM barra final)' : ''}`);
  return true;
}

let done;
const finished = new Promise((r) => (done = r));

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/report')) {
    // A página do callback devolve location.href completo (inclui fragmento, que o servidor nunca recebe).
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.end('ok');
      analyze('navegador (location.href, com fragmento)', body);
      done();
    });
    return;
  }
  if (url.startsWith('/cb')) {
    analyze('servidor (request-line)', `http://localhost:${PORT}${url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><meta charset=utf-8><title>spike</title><p>Callback recebido. Pode fechar esta aba.</p>` +
        `<script>fetch('/report',{method:'POST',body:location.href})</script>`,
    );
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Variante ${VARIANT}: ${VARIANTS[VARIANT].desc}`);
  console.log(`Callback: ${CB}`);
  console.log(`\nAbra e faça o login (CAFe):\n${launchUrl}\n`);
  if (OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${launchUrl}"` : process.platform === 'darwin' ? `open "${launchUrl}"` : `xdg-open "${launchUrl}"`;
    exec(cmd, () => {});
  }
  console.log(`Aguardando callback por até ${TIMEOUT_MS / 60000} min… (Ctrl+C cancela)`);
});

setTimeout(() => {
  console.log('\nTempo esgotado sem callback. Resultado: o navegador não chegou em http://localhost (ou o login não foi concluído).');
  done();
}, TIMEOUT_MS).unref();

finished.then(() => setTimeout(() => server.close(() => process.exit(0)), 300));
