/** Telas mínimas do /authorize (HTML simples, sem JS). Todo valor dinâmico passa por `esc`. */

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#111}
h1{font-size:1.3rem} .card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
input,button,a.btn{font:inherit;padding:.5rem .8rem;border-radius:6px;border:1px solid #888;background:#fff;color:#111;text-decoration:none;display:inline-block;margin:.2rem 0}
button.primary{background:#0b5;color:#fff;border-color:#0b5} .ok{color:#080} .err{color:#b00;font-weight:600} .muted{color:#555;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}input,button,a.btn{background:#222;color:#eee}.card{border-color:#444}.muted{color:#aaa}}
</style></head><body>${body}</body></html>`;
}

export function errorPage(message: string): string {
  return layout('Erro', `<h1>Não foi possível continuar</h1><p class="err">${esc(message)}</p>`);
}

export function identifyPage(txn: string, clientName: string | undefined, needsSecret: boolean, error?: string): string {
  return layout(
    'Autorizar acesso',
    `<h1>Autorizar acesso</h1>
<p><strong>${esc(clientName ?? 'Um aplicativo')}</strong> quer acessar seus dados acadêmicos neste serviço.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(txn)}">
<p><label>Seu e-mail<br><input type="email" name="email" required autocomplete="email"></label></p>
${needsSecret ? '<p><label>Senha de acesso do serviço<br><input type="password" name="secret" required autocomplete="off"></label></p>' : ''}
<button class="primary" name="acao" value="identificar">Continuar</button></form>`,
  );
}

export interface ConnectView {
  txn: string;
  google: boolean;
  moodle: boolean;
  notice?: string;
  error?: string;
}

export function connectPage(v: ConnectView): string {
  const t = encodeURIComponent(v.txn);
  return layout(
    'Conectar fontes',
    `<h1>Conectar fontes</h1>
${v.notice ? `<p class="ok">${esc(v.notice)}</p>` : ''}${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
<div class="card"><strong>Google</strong> (Classroom e Calendar)<br>
${v.google ? '<span class="ok">Conectado</span>' : `<a class="btn" href="/oauth/connect/google?txn=${t}">Conectar Google</a>`}</div>
<div class="card"><strong>Moodle</strong> (opcional, login institucional)<br>
${v.moodle ? '<span class="ok">Conectado</span>' : `<a class="btn" href="/oauth/connect/moodle?txn=${t}">Conectar Moodle</a>`}</div>
<div class="card"><strong>SIGAA</strong><br><span class="muted">A senha do SIGAA nunca é guardada: ela é enviada só na hora de sincronizar.</span></div>
<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(v.txn)}">
<button class="primary" name="acao" value="concluir">Concluir e autorizar</button>
<button name="acao" value="negar">Cancelar</button></form>`,
  );
}
