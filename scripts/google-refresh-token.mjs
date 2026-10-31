#!/usr/bin/env node
// Obtém UM refresh token do Google (fluxo OAuth "app instalado" com loopback + PKCE).
// Uso de uma vez só: nada é gravado em disco; o token é impresso no terminal.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-refresh-token.mjs
//
// Veja docs/GOOGLE.md. O cliente OAuth deve ser do tipo "App para computador" (Desktop).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (veja docs/GOOGLE.md).');
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64url');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent', // garante que o Google devolva refresh_token
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();

console.log('Abra este endereço no navegador (tentando abrir automaticamente):\n');
console.log(authUrl.toString(), '\n');
const opener = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
exec(opener, () => {});

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Tempo esgotado (5 min).')), 5 * 60_000);
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.searchParams.get('state') !== state && !url.searchParams.get('error')) {
      res.writeHead(400).end('state inválido');
      return;
    }
    const err = url.searchParams.get('error');
    const c = url.searchParams.get('code');
    if (!err && !c) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(err ? `Erro: ${err}` : 'Autorizado. Pode fechar esta aba e voltar ao terminal.');
    clearTimeout(timer);
    err ? reject(new Error(`Google recusou: ${err}`)) : resolve(c);
  });
}).finally(() => server.close());

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }),
});
const json = await res.json();
if (!res.ok || !json.refresh_token) {
  console.error('Falha ao trocar o código:', json.error ?? res.status, json.error_description ?? '');
  process.exit(1);
}

console.log('\nREFRESH TOKEN (guarde em local seguro; não é salvo em lugar nenhum):\n');
console.log(json.refresh_token);
