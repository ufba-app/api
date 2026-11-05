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

export function identifyPage(
  txn: string,
  clientName: string | undefined,
  needsSecret: boolean,
  error?: string,
  googleLogin = false,
): string {
  if (googleLogin) {
    return layout(
      'Autorizar acesso',
      `<h1>Autorizar acesso</h1>
<p><strong>${esc(clientName ?? 'Um aplicativo')}</strong> quer acessar seus dados acadêmicos neste serviço.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<p><a class="btn" href="/oauth/login/google?txn=${encodeURIComponent(txn)}">Entrar com Google</a></p>
<p class="muted">Use sua conta institucional. Classroom, Moodle e SIGAA são conectados na próxima tela.</p>`,
    );
  }
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
  /** Contas do Classroom conectadas e apps disponíveis; null quando o Classroom não está configurado no servidor. */
  classroom: { contas: string[]; apps: ('ufba' | 'convidado')[] } | null;
  moodle: boolean;
  notice?: string;
  error?: string;
}

export interface MoodleView {
  txn: string;
  host: string;
  launchUrl: string;
  /** Esquema `web+...` do redirect final, que esta página registra como tratador. */
  scheme: string;
  /** Endereço do tratador, com `%s` (exigência do registerProtocolHandler). */
  captureUrl: string;
  error?: string;
}

/** JSON seguro para dentro de <script>. */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Passo a passo do Moodle. Única tela com JS: registra o serviço como tratador de `web+ufba://` para o navegador
 * entregar o token automaticamente ao fim do login. A caixa de colar fica como plano B.
 */
export function moodlePage(v: MoodleView): string {
  return layout(
    'Conectar Moodle',
    `<h1>Conectar o Moodle</h1>
${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
<ol>
<li><strong>Ative a captura automática</strong> (só na primeira vez neste navegador):<br>
<button type="button" id="ativar">Ativar captura</button>
<span id="ativar-msg" class="muted"></span><br>
<span class="muted">O navegador vai perguntar se este serviço pode abrir links <code>${esc(v.scheme)}</code>
(no Chrome/Edge, um ícone à direita da barra de endereço). Clique em <strong>Permitir</strong>.</span></li>
<li><strong>Abra o login do Moodle</strong> (${esc(v.host)}) e entre normalmente com seu login institucional.
Se já estava logado, ele pula o login.<br>
<a class="btn" href="${esc(v.launchUrl)}">Abrir login do Moodle</a></li>
<li>Pronto: ao terminar, você volta para cá com o Moodle conectado.</li>
</ol>
<p class="muted">Apareceu a janela do Windows &ldquo;Obter um aplicativo para abrir este link&rdquo;? A captura não estava
ativa: feche a janela, volte aqui, refaça o passo 1 (e permita) e depois o passo 2.</p>
<details><summary>Não funcionou? Colar o link manualmente</summary>
<form method="post" action="/oauth/connect/moodle"><input type="hidden" name="txn" value="${esc(v.txn)}">
<p><label>Link que começa com <code>${esc(v.scheme)}://token=</code><br><textarea name="link" rows="4" required autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;font:inherit;padding:.5rem;border-radius:6px;border:1px solid #888;background:inherit;color:inherit"></textarea></label></p>
<p class="muted">Esse link contém uma chave de acesso ao seu Moodle. Não envie a ninguém. O serviço guarda a chave cifrada e usa só para leitura.</p>
<button class="primary" type="submit">Conectar</button></form></details>
<p><a class="btn" href="/oauth/connect?txn=${encodeURIComponent(v.txn)}">Voltar</a></p>
<script>
document.getElementById('ativar').addEventListener('click', function () {
  var msg = document.getElementById('ativar-msg');
  try {
    navigator.registerProtocolHandler(${jsLiteral(v.scheme)}, ${jsLiteral(v.captureUrl)});
    msg.textContent = ' Pedido enviado: confirme no navegador e siga para o passo 2.';
  } catch (e) {
    msg.textContent = ' Este navegador não permite a captura automática: use a opção de colar o link abaixo.';
  }
});
</script>`,
  );
}

function classroomCard(c: ConnectView['classroom'], t: string): string {
  if (c === null) {
    return '<div class="card"><strong>Google Classroom</strong><br><span class="muted">Não disponível neste servidor.</span></div>';
  }
  const lista = c.contas.length ? `<ul>${c.contas.map((x) => `<li class="ok">${esc(x)}</li>`).join('')}</ul>` : '';
  const ufba = c.apps.includes('ufba')
    ? `<a class="btn" href="/oauth/connect/classroom?txn=${t}&amp;app=ufba">Conectar Classroom @ufba.br</a><br>`
    : '';
  const convidado = c.apps.includes('convidado')
    ? `<a class="btn" href="/oauth/connect/classroom?txn=${t}&amp;app=convidado">Conectar outra conta (só convidados)</a>
<br><span class="muted">Para turmas em gmail pessoal: só funciona para contas convidadas, e o acesso precisa ser
renovado a cada 7 dias.</span>`
    : '';
  return `<div class="card"><strong>Google Classroom</strong> (somente leitura, inclusive os anexos das turmas)<br>
<span class="muted">Use a conta em que você está nas turmas. O serviço só baixa arquivos anexados no Classroom.</span>
${lista}${ufba}${convidado}</div>`;
}

export function connectPage(v: ConnectView): string {
  const t = encodeURIComponent(v.txn);
  return layout(
    'Conectar fontes',
    `<h1>Conectar fontes</h1>
${v.notice ? `<p class="ok">${esc(v.notice)}</p>` : ''}${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
${classroomCard(v.classroom, t)}
<div class="card"><strong>Moodle</strong> (opcional, login institucional)<br>
${v.moodle ? '<span class="ok">Conectado</span>' : `<a class="btn" href="/oauth/connect/moodle?txn=${t}">Conectar Moodle</a>`}</div>
<div class="card"><strong>SIGAA</strong><br><span class="muted">A senha do SIGAA nunca é guardada: ela é enviada só na hora de consultar.</span></div>
<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(v.txn)}">
<button class="primary" name="acao" value="concluir">Concluir e autorizar</button>
<button name="acao" value="negar">Cancelar</button></form>`,
  );
}
