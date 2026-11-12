# API do app web (ufba.app)

Contrato entre o `platform` (API, `https://api.ufba.app`) e o app web (`https://ufba.app`). O web é a única
interface: login, conexões, autorização de clientes OAuth, apps autorizados e leitura dos dados. O backend não tem
nenhuma tela: só JSON e redirecionamentos do OAuth.

Nomes de código, rotas e chaves JSON em inglês; mensagens para a pessoa (`message`) em pt-BR.

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
→ 204, Set-Cookie: <sessão>
```

5. O web limpa `?code&state` da URL (`history.replaceState`) e apaga o verifier.

### Sair

`DELETE /session` → 204. Apaga a sessão no banco, limpa o cookie e apaga a senha do SIGAA guardada para o web
(ela só abria com a K desta sessão).

### Quem está logado

```
GET /me → 200
{
  "id": "uuid",
  "email": "fulano@ufba.br",
  "name": "string" | null,
  "connections": {
    "sigaa": { "status": "connected" | "disconnected" | "password_required", "login": "string" | null },
    "moodle": { "status": "connected" | "disconnected" | "reconnect_required", "account": "string" | null },
    "classroom": {
      "available": true,
      "apps": ["ufba", "guest"],
      "accounts": [ { "email": "string", "status": "connected" | "reconnect_required" } ]
    }
  }
}
```

- `sigaa.password_required`: existe senha guardada, mas ela não abre com esta sessão (sessão nova depois de
  expirar) ou o SIGAA recusou a senha. A pessoa digita de novo.
- `classroom.available = false`: o servidor não tem Google configurado (esconder o bloco).

## 3. Segurança das chamadas

- O web chama a API direto do navegador com `credentials: 'include'`.
- CORS: só as origens da casa, `WEB_ORIGIN` (painel) e `AUTH_ORIGIN` (login e autorização), com `Access-Control-Allow-Credentials: true`.
- Toda rota que **muda estado** (POST/PUT/PATCH/DELETE) com cookie exige:
  - `Content-Type: application/json` (exceto DELETE sem corpo);
  - header `X-UFBA: 1`;
  - `Origin` igual a `WEB_ORIGIN` ou `AUTH_ORIGIN`.
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
| 501 | `not_supported` | a fonte não oferece essa leitura |
| 502 | `source_unavailable` | a fonte falhou ou respondeu algo inesperado |
| 500 | `internal_error` | erro nosso |

## 5. Conexões

Todas com cookie de sessão.

### SIGAA

```
POST /connections/sigaa   { "login": "string", "password": "string" }   → 204
DELETE /connections/sigaa                                               → 204
```

- Valida com 1 login real no SIGAA; guarda a senha cifrada com a K **desta sessão**. Erros:
  `422 invalid_credentials`, `429 too_many_attempts`, `502 source_unavailable`.
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
- Erros: `422 invalid_credentials` (link incompleto, de outro pedido, recusado pelo Moodle), `502 source_unavailable`.

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

```
GET /authorize/requests/{id} → 200
{
  "id": "string",
  "client": {
    "domain": "claude.ai",
    "redirectUri": "https://claude.ai/api/mcp/auth_callback",
    "name": "Claude" | null,
    "logoUrl": "https://api.ufba.app/client-logos/<sha256>" | null,
    "verified": true,
    "metadata": "present" | "absent"
  },
  "signedIn": true,
  "sources": [ { "source": "sigaa" | "moodle" | "classroom", "status": "connected" | "disconnected" | "password_required" | "reconnect_required" } ] | null,
  "expiresAt": "ISO-8601"
}
```

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

```
GET /authorized-apps → 200
{
  "apps": [
    {
      "clientId": "string",
      "domain": "claude.ai",
      "name": "Claude" | null,
      "logoUrl": "string" | null,
      "verified": true,
      "authorizedAt": "ISO-8601",
      "lastUsedAt": "ISO-8601" | null,
      "sigaa": true
    }
  ]
}
DELETE /authorized-apps/{clientId} → 204
```

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

```ts
type Course = { id: string; name: string; code?: string; url?: string };
type Deadline = {
  id: string; title: string; dueAt: string; courseId?: string; courseName?: string;
  type?: string; description?: string; url?: string;
};
type ActivityType = 'assignment' | 'exam' | 'material' | 'forum' | 'announcement' | 'other';
type Attachment = { name: string; mimeType?: string; sizeBytes?: number; ref: string };
type Activity = {
  id: string; type: ActivityType; title: string; section?: string; description?: string;
  dueAt?: string; url?: string; attachments: Attachment[]; links?: string[];
  openInBrowser?: { name: string; url: string }[]; forumId?: string;
};
type Discussion = {
  id: string; title: string; message?: string; author?: string; publishedAt?: string; attachments: Attachment[];
};
```

- Datas em ISO-8601. Textos vêm como texto puro (renderizar como texto, nunca HTML).
- Classroom: arquivos do Drive vêm em `openInBrowser` (a pessoa abre no Google); `attachment` só para anexos de
  `attachments`.
- Erros típicos: `409 source_not_connected`, `409 account_ambiguous`, `501 not_supported`, `502 source_unavailable`.

## 9. Configuração (env da API)

| var | exemplo | |
|---|---|---|
| `PUBLIC_URL` | `https://api.ufba.app` | URL pública da API |
| `WEB_ORIGIN` | `https://ufba.app` | painel; liga o modo web (CORS, CSRF, cliente `ufba-web`) |
| `AUTH_ORIGIN` | `https://auth.ufba.app` | telas de login e `/authorize`; `redirect_uri` do `ufba-web`. Opcional: sem ela, usa `WEB_ORIGIN` |
| `HOST` | `0.0.0.0` | no Railway |
| `DATABASE_URL`, `SECRETS_KEY`, `GOOGLE_*` | | como antes |

`config/verified-apps.json`: `[{ "domain": "claude.ai", "name": "Claude", "logo": "claude.png" }]`, logos em
`config/verified-logos/`. Mudar a lista = PR.
