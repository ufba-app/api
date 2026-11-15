# API do app web (ufba.app)

Contrato entre o `platform` (API, `https://api.ufba.app`) e o app web (`https://ufba.app`). O web é a única
interface: login, conexões, autorização de clientes OAuth, apps autorizados e leitura dos dados. O backend não tem
nenhuma tela: só JSON e redirecionamentos do OAuth.

Nomes de código, rotas e chaves JSON em inglês; mensagens para a pessoa (`message`) em pt-BR.

**Formatos: `openapi.json`.** Rotas, parâmetros, corpos, respostas e códigos de erro estão no
[`openapi.json`](../openapi.json) (servido também em `GET {API}/openapi.json`), gerado dos schemas Zod de
`src/application/web/contract.ts` com `npm run openapi`. O CI falha se o código mudar sem o arquivo. O web gera
tipos e Zod a partir dele. Este documento fica com os **fluxos e as regras**.

## 1. Premissas

- **Mesmo site.** Painel (`{WEB}` = `https://ufba.app`), auth (`{AUTH}` = `https://auth.ufba.app`) e API em `ufba.app`.
  Em dev: painel `http://localhost:3001`, auth `http://localhost:3002`, API
  `http://localhost:3000`. Nunca `*.up.railway.app` (Public Suffix List: o cookie não funciona).
- **O token carrega a chave K** (`<random>.<K>`) que decifra a senha do SIGAA daquele cliente. O banco guarda só
  o sha256 do token inteiro. Por isso a sessão do web é um cookie **HttpOnly emitido pela API**; o JavaScript do web
  nunca vê token.
- O web é o cliente OAuth da casa: `client_id = "ufba-web"`, `redirect_uri = {AUTH_ORIGIN}/sign-in/callback`,
  criado no boot. Não passa por tela de consentimento.

## 2. Sessão

| | |
|---|---|
| Cookie | `__Host-ufba_session` (quando `PUBLIC_URL` é https) ou `ufba_session` (http, dev) |
| Atributos | `HttpOnly; SameSite=Lax; Path=/; Secure` (https); sem `Domain` (só o host da API) |
| Marcador | `ufba_signed_in=1` (ver abaixo) |
| Valor | token de sessão `<random>.<K>` (tipo `session` em `oauth_tokens`) |
| Duração | 30 dias **desde o último uso** (renovada a cada uso, no máximo 1 vez por hora) |

### Login

1. O web gera `code_verifier`, `code_challenge` (S256) e `state`; guarda verifier e state em `sessionStorage`.
2. Navega para `GET {API}/authorize?response_type=code&client_id=ufba-web&redirect_uri={AUTH}/sign-in/callback&code_challenge=…&code_challenge_method=S256&state=…`.
3. A API manda direto para o login do Google (só `@ufba.br`). No retorno, emite o code e redireciona para
   `{AUTH}/sign-in/callback?code=…&state=…` (ou `?error=access_denied&error_description=…`, com
   `error_description` em pt-BR pronto para mostrar, ex.: "marina@gmail.com não é um e-mail @ufba.br. Entre com a
   sua conta institucional.").
4. O web confere o `state` e chama:

```
POST /session
Content-Type: application/json
X-UFBA: 1
{ "code": "…", "codeVerifier": "…", "redirectUri": "{AUTH}/sign-in/callback" }
→ 204, Set-Cookie: <sessão> e Set-Cookie: <marcador>
```

5. O web limpa `?code&state` da URL (`history.replaceState`) e apaga o verifier.

### Cookie marcador `ufba_signed_in`

O cookie de sessão não tem `Domain` (só vai para `api.ufba.app`), então quem fica na frente do painel (a landing, o
servidor que serve o painel) não o vê. Para decidir o redirect sem piscar a tela, a API emite junto um **marcador sem
segredo**:

`ufba_signed_in=1; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=.ufba.app; Max-Age=<o da sessão>`

- **Não autentica nada.** A API continua validando só o cookie de sessão; o marcador diz apenas "houve login" e pode estar
  velho (ex.: sessão revogada no servidor). Quem o lê trata como dica de UX, nunca como prova.
- Emitido em `POST /session` e **reemitido em `GET /me`** quando a sessão é válida (idempotente, mesmos atributos, `Max-Age` = o que resta da sessão): quem entrou antes do marcador existir o ganha na próxima chamada, sem loop de redirect.
  sem loop de redirect.
- Apagado (`Max-Age=0`, mesmo `Domain` e `Path`) em `DELETE /session`, `DELETE /me` e em
  qualquer resposta `401 session_expired`.
- `Domain` vem da config: o sufixo que `WEB_ORIGIN`, `AUTH_ORIGIN` e `PUBLIC_URL` têm em comum (hoje `.ufba.app`).
  Em dev (http, localhost) não há `Domain` nem `Secure`. É `HttpOnly`: só o servidor lê (o JavaScript do painel não).

### Sair

`DELETE /session` → 204. Apaga a sessão no banco, limpa o cookie e apaga a senha do SIGAA guardada para o web
(ela só abria com a K desta sessão).

### Excluir a conta

`DELETE /me` → 204 (sessão + CSRF). Apaga a pessoa e tudo dela: sessões, apps autorizados, contas conectadas,
senhas guardadas e os **vínculos com o SIGAA e o AVA** (seção 5). Limpa o cookie. É o único jeito de trocar o SIGAA
ou o AVA ligados à conta: excluir e entrar de novo. O web confirma antes de chamar (ação sem volta).

### Quem está logado

`GET /me` → 200 `Me` (ver `openapi.json`).

- `sigaa.password_required`: existe senha guardada, mas ela não abre com esta sessão (sessão nova depois de
  expirar) ou o SIGAA recusou a senha. A pessoa digita de novo.
- `classroom.available = false`: o servidor não tem Google configurado (esconder o bloco).

## 3. Segurança das chamadas

- O web chama a API direto do navegador com `credentials: 'include'`.
- CORS: só as origens da casa, `WEB_ORIGIN` (painel; **lista separada por vírgula**, a primeira é a principal, usada nos redirects da API para o painel) e `AUTH_ORIGIN` (login e autorização, único), com `Access-Control-Allow-Credentials: true`.
- Toda rota que **muda estado** (POST/PUT/PATCH/DELETE) com cookie exige:
  - `Content-Type: application/json` (exceto DELETE sem corpo);
  - header `X-UFBA: 1`;
  - `Origin` igual a uma das origens de `WEB_ORIGIN` ou a `AUTH_ORIGIN`.
  Senão → `403 csrf_rejected`.
- As rotas de dados (seção 7) aceitam também `Authorization: Bearer <access token>` (clientes OAuth de terceiros);
  com Bearer não há checagem de CSRF.

## 4. Erros

Todas as rotas desta API (exceto `/authorize`, `/token`, `/register`, que seguem o OAuth) respondem erros assim:

```
{ "error": "<code_snake_case>", "message": "<texto pt-BR para mostrar>" }
```

| status | error | quando |
|---|---|---|
| 400 | `invalid_request` | corpo/parâmetro inválido |
| 401 | `session_expired` | sem cookie, cookie inválido ou expirado → o web vai para `/sign-in` |
| 403 | `csrf_rejected` | faltou `X-UFBA`/JSON ou `Origin` errado |
| 404 | `request_not_found` | pedido de autorização inexistente ou já decidido |
| 404 | `not_found` | recurso inexistente (ex.: app não autorizado) |
| 410 | `request_expired` | pedido de autorização expirado (15 min) |
| 409 | `source_not_connected` | a fonte (ou a conta) não está conectada / precisa reconectar |
| 409 | `account_ambiguous` | mais de uma conta na fonte e nenhuma escolhida (`?account=`) |
| 422 | `invalid_credentials` | senha do SIGAA errada / link do Moodle inválido |
| 429 | `too_many_attempts` | muitas senhas erradas (SIGAA) |
| 409 | `source_account_mismatch` | esta conta já está ligada a outro SIGAA/AVA (para trocar: excluir a conta) |
| 409 | `source_account_taken` | este SIGAA/AVA já está ligado a outra conta do ufba.app |
| 403 | `source_account_not_owned` | a conta do AVA não é da pessoa logada (não é o login institucional dela) |
| 501 | `not_supported` | a fonte não oferece essa leitura |
| 502 | `source_unavailable` | a fonte falhou ou respondeu algo inesperado |
| 500 | `internal_error` | erro nosso |

## 5. Conexões

Todas com cookie de sessão.

**Vínculo fixo.** Na primeira conexão bem-sucedida, a conta do ufba.app fica ligada ao titular na fonte, nos dois
sentidos: o CPF no SIGAA e o usuário do AVA no Moodle. Esse titular não entra em outra conta do ufba.app
(`409 source_account_taken`), e a conta não troca de titular (`409 source_account_mismatch`). Desconectar apaga a
senha ou o token, mas **mantém o vínculo**: reconectar só com o mesmo titular. Para trocar, `DELETE /me`.

### SIGAA

```
POST /connections/sigaa   { "login": "string", "password": "string" }   → 204
DELETE /connections/sigaa                                               → 204
```

- `login` é o CPF: mande só os 11 dígitos (com máscara também é aceito; o vínculo normaliza).
- Valida com 1 login real no SIGAA; guarda a senha cifrada com a K **desta sessão**. Erros:
  `422 invalid_credentials`, `429 too_many_attempts`, `502 source_unavailable`,
  `409 source_account_mismatch` (outro CPF já ligado a esta conta; recusado antes de falar com o SIGAA),
  `409 source_account_taken` (CPF de outra conta; só depois da senha certa, para não revelar quem está cadastrado).
- A senha nunca volta em resposta nem em erro. O web limpa o campo depois do envio.

### Moodle (login no navegador da pessoa)

```
POST /connections/moodle/start   {}   → 200 { "launchUrl": "https://ava.ufba.br/admin/tool/mobile/launch.php?…", "scheme": "web+ufba" }
POST /connections/moodle   { "link": "web+ufba://token=…" }   → 204
DELETE /connections/moodle   → 204
```

1. O web registra `navigator.registerProtocolHandler(scheme, "{WEB}/connections/moodle/capture?u=%s")`.
2. Abre `launchUrl` (nova aba). A pessoa faz o login institucional; o AVA termina em `web+ufba://token=…`, o
   navegador abre `{WEB}/connections/moodle/capture?u=<link>`.
3. Essa página faz `POST /connections/moodle { link: u }` e limpa a URL. Plano B: a pessoa cola o link num campo.
- Só aceita a conta do AVA da própria pessoa: login institucional (Shibboleth) e usuário igual ao do e-mail de login
  (`luiz.a` ↔ `luiz.a@ufba.br`). Senão, `403 source_account_not_owned`.
- Erros: `422 invalid_credentials` (link incompleto, de outro pedido, recusado pelo Moodle), `502 source_unavailable`,
  `403 source_account_not_owned`, `409 source_account_mismatch`, `409 source_account_taken`.

### Classroom (pode haver várias contas)

```
GET /connections/classroom/start?app=ufba|guest   (navegação de página inteira, não fetch)
DELETE /connections/classroom/{email}   → 204
```

- `start` redireciona para o Google; ao voltar, a API redireciona para
  `{WEB}/connections?connected=classroom` ou `{WEB}/connections?error=<code>&message=<texto>`.
- `app=ufba`: conta `@ufba.br`. `app=guest`: gmail pessoal (app em teste, só usuários cadastrados).

## 6. Autorizar um cliente de terceiros (ex.: Claude)

1. O cliente abre `GET {API}/authorize?…` (OAuth 2.1 + PKCE). A API valida cliente e `redirect_uri` e redireciona
   para `{AUTH}/authorize?request=<id>`. Pedido inválido (cliente desconhecido, `redirect_uri` não registrado) **não**
   redireciona para o cliente: vai para `{AUTH}/authorize/error?error=<code>&message=<texto>`.
2. O web pede os dados:

`GET /authorize/requests/{id}` → 200 `RequestInfo`.

- Funciona **sem sessão**: aí vem `signedIn: false` e `sources: null` (dá para mostrar "Claude quer acessar seus
  dados" antes do login). O web manda para `/sign-in?return=/authorize?request=<id>` e volta depois.
- `domain`: host do `redirect_uri`, sempre em ASCII (punycode). Mostrar em destaque, exatamente como vem.
- `name`/`logoUrl`: de `config/verified-apps.json` se o domínio for verificado e a entrada tiver; senão do
  documento de metadados do cliente (quando `client_id` é uma URL https); senão `null`. O `client_name` do
  `/register` é ignorado. Nome saneado (sem controle/bidi, até 60 caracteres). Logo servido pela própria API
  (PNG/JPEG/WebP até 256 KB; SVG recusado).
- `sources`: o acesso não é por escopo: o cliente lê todas as fontes conectadas da pessoa. SIGAA só vai junto se
  estiver `connected` nesta sessão.

3. Decisão:

```
POST /authorize/requests/{id}/approve   {}   → 200 { "redirectTo": "<redirect_uri>?code=…&state=…" }
POST /authorize/requests/{id}/deny      {}   → 200 { "redirectTo": "<redirect_uri>?error=access_denied&state=…" }
```

- O web faz `window.location.assign(redirectTo)` sem montar nem validar a URL.
- Ao aprovar, a senha do SIGAA da sessão é decifrada em memória e cifrada de novo com uma chave nova, que só o token
  do cliente vai carregar. A pessoa não digita nada.
- Erros: `404 request_not_found` (inclusive pedido já decidido), `410 request_expired`, `401 session_expired`.

### Logos

`GET /client-logos/{hash}` → a imagem (`Content-Type` fixo, `nosniff`, cache 24 h). CSP do web:
`img-src 'self' https://api.ufba.app data:`.

## 7. Apps autorizados

`GET /authorized-apps` → 200 `{ apps: AuthorizedApp[] }`; `DELETE /authorized-apps/{clientId}` → 204.

- Lista os clientes com token válido da pessoa (o próprio web não entra).
- Revogar apaga os tokens do cliente e a senha do SIGAA cifrada para ele. Efeito imediato.

## 8. Dados (leitura ao vivo)

Cookie de sessão **ou** `Authorization: Bearer`. Cada chamada consulta a fonte na hora; nada é gravado.
`{source}` = `sigaa` | `moodle` | `classroom`. `?account=` escolhe a conta quando há mais de uma (ver `/accounts`).

```
GET /accounts → { "accounts": [ { "source": "moodle", "account": "ava.ufba.br:fulano", "status": "connected" | "reconnect_required" } ] }
GET /sources/{source}/courses?account=&all=true      → { "courses": Course[] }
GET /sources/{source}/deadlines?account=             → { "deadlines": Deadline[] }
GET /sources/{source}/courses/{courseId}?account=    → { "courseId": "…", "activities": Activity[] }
GET /sources/{source}/forums/{forumId}?account=      → { "forumId": "…", "discussions": Discussion[] }
GET /sources/{source}/announcements/{id}?account=    → { "announcement": Discussion }   (hoje só sigaa)
GET /sources/{source}/attachment?account=&ref=&name= → o arquivo (download)
```

Os tipos (`Course`, `Deadline`, `Activity`, `Discussion`, `Attachment`) estão no `openapi.json`.

- Datas em ISO-8601. Textos vêm como texto puro (renderizar como texto, nunca HTML).
- Classroom: arquivos do Drive vêm em `openInBrowser` (a pessoa abre no Google); `attachment` só para anexos de
  `attachments`.
- Erros típicos: `409 source_not_connected`, `409 account_ambiguous`, `501 not_supported`, `502 source_unavailable`.

## 9. Configuração (env da API)

| var | exemplo | |
|---|---|---|
| `PUBLIC_URL` | `https://api.ufba.app` | URL pública da API |
| `WEB_ORIGIN` | `https://meu.ufba.app` | painel; liga o modo web (CORS, CSRF, cliente `ufba-web`). Lista separada por vírgula na transição (`https://meu.ufba.app,https://ufba.app`): a primeira é a principal, todas valem para CORS e CSRF. Validada no boot (https em produção, sem barra final, sem curinga) |
| `AUTH_ORIGIN` | `https://auth.ufba.app` | telas de login e `/authorize`; `redirect_uri` do `ufba-web`. Opcional: sem ela, usa a origem principal de `WEB_ORIGIN` |
| `HOST` | `0.0.0.0` | no Railway |
| `DATABASE_URL`, `SECRETS_KEY`, `GOOGLE_*` | | como antes |

`config/verified-apps.json`: `[{ "domain": "claude.ai", "name": "Claude", "logo": "claude.png" }]`, logos em
`config/verified-logos/`. Mudar a lista = PR.
