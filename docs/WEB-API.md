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

`DELETE /session` → 204. Apaga a sessão no banco, limpa o cookie e apaga **a cópia da DK desta sessão** (ela só abria com a
K desta sessão). A cópia da DK é **por sessão** (`ufba-web:<sessão>`): sair num aparelho **não** tranca os outros, e desbloquear
num aparelho não sobrescreve a cópia dos outros (o limite é de 20 sessões mais novas por pessoa).

### Excluir a conta

`DELETE /me` → 204 (sessão + CSRF). Apaga a pessoa e tudo dela: sessões, apps autorizados, contas conectadas,
senhas guardadas e os **vínculos com o SIGAA e o AVA** (seção 5). Limpa o cookie. É o único jeito de trocar o SIGAA
ou o AVA ligados à conta: excluir e entrar de novo. O web confirma antes de chamar (ação sem volta).

### Quem está logado

`GET /me` → 200 `Me` (ver `openapi.json`).

- `sigaa.password_required`: existe senha guardada, mas ela não abre com esta sessão (sessão nova depois de
  expirar) ou o SIGAA recusou a senha. A pessoa digita de novo.
- `sigaa.status = locked`: não há senha utilizável nesta sessão, mas existe cópia mestra (passkey). A tela oferece
  "Desbloquear" (um toque). `sigaa.passkey.slots` diz quantas cópias existem.
- `classroom.available = false`: o servidor não tem Google configurado (esconder o bloco).

### Chave mestra do SIGAA com passkey

Desenho em `docs/specs/2026-11-14-chave-mestra-passkey.md`. O servidor só guarda e devolve o texto cifrado **no
navegador** com o PRF da passkey; ele nunca abre a cópia. Rotas (cookie + CSRF), todas em `openapi.json`:

- `GET /sigaa/passkey` → `{ passkeys: [{ credentialId, prfSalt, label, createdAt, lastUnlockedAt }] }`. O `prfSalt` não é
  segredo: o navegador precisa dele antes do toque (`evalByCredential`).
- `POST /sigaa/passkey` `{ credentialId, prfSalt, iv, ciphertext, label? }` → 204. Exige o SIGAA `connected` **nesta**
  sessão (409 `source_not_connected`). Limite de 5 cópias (409 `passkey_limit_reached`) e 5 gravações por hora (429).
- `POST /sigaa/passkey/slot` `{ credentialId }` → `{ prfSalt, iv, ciphertext }` (o id vai no corpo, não na URL). 10 por
  minuto. 404 `passkey_not_found`. Marca `lastUnlockedAt`.
- `DELETE /sigaa/passkey/{credentialId}` → 204 (a conexão do SIGAA não muda).
- `DELETE /connections/sigaa` apaga o cofre, as cópias da DK (painel e apps) e as das passkeys; `DELETE /me` apaga em cascata. Sair (`DELETE /session`) apaga só a cópia da DK da sessão: o cofre e as passkeys **ficam**.

**A passkey guarda a DK, não a senha** (docs/specs/2026-11-15-dk-chave-de-dados.md). A senha do SIGAA fica cifrada UMA vez
por pessoa, num cofre (`sigaa_vaults`), com a DK (chave de dados aleatória, nunca guardada em claro). Cada sessão do
painel e cada app autorizado guarda uma cópia da DK cifrada com a K do próprio token; cada passkey guarda outra, cifrada
no navegador com o PRF (AAD `userId || credentialId || "2"`). Trocar a senha recifra só o cofre: as passkeys e os apps
seguem valendo.

- `GET /connections/sigaa/key` → `{ dk }` (32 bytes, base64url). Para **ativar**: o navegador cifra a DK com a passkey e a
  grava (`POST /sigaa/passkey`). Exige o SIGAA aberto **nesta** sessão (409 `source_not_connected`); `no-store`; 10 por hora.
  **Exige o cabeçalho `X-UFBA: 1`** (403 `csrf_rejected` sem ele): é um GET que entrega a DK e gasta limite, e o cabeçalho
  personalizado força o preflight de CORS, então outro subdomínio de `*.ufba.app` não o dispara com um `<img>`.
- `POST /connections/sigaa/unlock` `{ dk }` → 204. Para **desbloquear**: o navegador abre a cópia da passkey (ou recebe a
  DK pelo QR) e manda a DK; o servidor abre o cofre e a sessão fica conectada, **sem a senha passar pelo navegador**. DK que
  não abre: 422 `invalid_credentials`. Sem cofre: 409. 10 por minuto.
- `POST /connections/sigaa` com a senha: se esta sessão já tem a DK, recifra só o cofre (as passkeys ficam); se **não**
  tem (a pessoa digitou em vez de desbloquear), cria DK **nova** e apaga as cópias da DK dos apps e as das passkeys.
- `sigaa.status`: `connected` (esta sessão abre); `locked` (há cofre válido e passkey: um toque religa, `login` já vem
  preenchido); `password_required` (há cofre mas nada abre aqui, sem passkey, ou o SIGAA recusou a senha: digitar de novo,
  e isso **não** exige reativar a passkey se a sessão tiver a DK); `disconnected` (sem cofre).

Desbloquear: `GET /sigaa/passkey` → `get` da passkey com `evalByCredential` → `POST …/slot` → abrir a DK no navegador →
`POST /connections/sigaa/unlock`. Qualquer falha cai no formulário da senha. Apps que tinham a senha guardada no formato
antigo pedem reautorização.

### Liberar o SIGAA por QR (correio entre o computador e o celular)

Método escolhido em 15/11/2026 (`dev/ufba/handoffs/metodo-chave-mestra-sigaa.md`; desenho em
`docs/specs/2026-11-14-chave-mestra-passkey.md` §13). O computador mostra um QR **do próprio ufba.app**; o celular da
**mesma conta** lê com a câmera comum, confirma com a digital (a passkey **nunca sai do celular**; o PRF só é usado ali)
e entrega ao computador um pacote lacrado que só ele abre. A API é só o **correio**: guarda bytes que não consegue abrir.
Todas as rotas exigem sessão e CSRF e respondem `Cache-Control: no-store`.

- `POST /pairings` `{ label?, client? }` → 201 `{ id, expiresAt }`. O **computador** abre o pedido (preso à conta dele;
  vale 5 min; no máximo 3 abertos por pessoa, 10 por hora). O QR leva `id` e, **no fragmento** (`#…`, que o navegador não
  manda ao servidor), a chave pública P-256 descartável do computador.
- `GET /pairings/{id}/info` → `{ seenBrowser, seenOs, label, client, createdAt, expiresAt, delivered }`. O **celular** mostra
  "Liberar *Firefox 160 no Windows*, pedido às 14:03?" antes de pedir a digital. **`seenBrowser` e `seenOs` são o que a API VIU**
  ao receber `POST /pairings` (User-Agent; nulos se não reconhecer): é o que a tela mostra primeiro. **`label` e `client` são o que
  o COMPUTADOR escreveu e não são confiáveis** (quem mostra um QR de golpe escreve o que quiser): mostre-os, se quiser, como
  "o computador diz", nunca como fato. A cidade aproximada não é gravada (exigiria um serviço de geolocalização por IP).
  Pedido de outra conta responde **404** `pairing_not_found` (não revela que existe).
- `POST /pairings/{id}` `{ pub, iv, ciphertext }` → 204. O **celular** entrega o pacote (`pub` = chave pública efêmera do
  celular, 65 bytes; `iv` 12 bytes; `ciphertext` AES-GCM, base64url). **Uma entrega por pedido**: a segunda dá 409
  `pairing_already_delivered`. 404 se vencido ou de outra conta.
- `GET /pairings/{id}` → 200 `{ status: "pending" }` ou `{ status: "delivered", pub, iv, ciphertext }`. O **computador**
  consulta a cada ~1,5 s; quando o pacote chega, a leitura o devolve e **apaga o pedido** (uso único). Depois, ou vencido, 404.
- Lacre (feito nos navegadores, não aqui): `chave = HKDF-SHA256(ECDH, salt = id, info = "ufba.app/pair/v1" || pubPC || pubCelular)`,
  AES-256-GCM, AAD = `id`. O conteúdo do pacote é a **DK** aberta da cópia da passkey; o computador a abre e chama o
  `POST /connections/sigaa/unlock`.
- Falha em qualquer ponto (sem celular, navegador sem WebAuthn, pedido vencido): a tela cai em "digite a senha".

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

## 5.1 Vida acadêmica (histórico lido pela IA e grade do curso)

Desenho em `docs/specs/2026-11-15-vida-academica.md`; brief de telas em `dev/ufba/handoffs/design-vida-academica.md`. Depois de
conectar o SIGAA, o painel oferece **importar a vida acadêmica**: a API lê o histórico (a IA só **lê**, Haiku 5.5), a pessoa
**confere e confirma** antes de gravar, e a grade do curso (currículo **Ativo** do SIGAA público) é adequada ao histórico por
equivalências. Tudo é **estimativa** do lado da grade; o histórico é a fonte oficial do que foi feito. Nada de identidade
(nome, CPF, nascimento, docentes) existe no banco; o PDF e o texto enviado ao provedor nunca são gravados.

Todas as rotas exigem sessão e CSRF (os `POST` sem dado de negócio mandam `{}` no corpo, como as demais rotas de mudança).

- `GET /me/academic` → `{ available, consent, status, failure, verified, reader, importedAt, curriculumStatus, summary, draft }`.
  `available = false`: o servidor não tem chave do provedor de IA (esconder a oferta). `status`: `NONE` | `RUNNING` |
  `NEEDS_CONFIRMATION` | `READY` | `FAILED` (+ `failure`: `REDACTION_REFUSED`, `READER_FAILED`, `SIGAA_UNAVAILABLE`, `PDF_INVALID`,
  `SESSION_EXPIRED`, `TIMEOUT`). `draft` só em `NEEDS_CONFIRMATION` (o que foi lido: componentes, pendentes, horas, avisos);
  `summary` só com o histórico gravado. `curriculumStatus` (a grade do curso): `NONE` | `READY` | `IMPORTING` | `UNAVAILABLE`.
  A tela acompanha a importação consultando esta rota (a importação roda em segundo plano).
- `PUT /me/academic/consent` `{ accepted }` → 204. Aceita (ou revoga) o envio das disciplinas e notas, **sem identidade**, ao
  provedor de IA. Revogar exige novo aceite para importar; não apaga o que já foi gravado.
- `POST /me/academic/import` → **202**. Exige consentimento (409 `consent_required`), o SIGAA aberto **nesta** sessão (409
  `source_not_connected`), nenhuma importação em andamento (409 `import_in_progress`), no máximo 3 por dia por pessoa (429
  `too_many_attempts`) e a leitura disponível (503 `import_unavailable`: sem chave, ou o teto de gasto do mês foi atingido).
- `POST /me/academic/confirm` → 204. Grava o histórico (substitui o anterior), o perfil do portal e apaga o rascunho. **Com
  `verified = false` a confirmação é obrigatória e a tela mostra `draft.verification.warnings`.** 404 `import_not_found` sem rascunho
  (o rascunho vale 7 dias).
- `DELETE /me/academic` → 204. Apaga histórico, rascunho e perfil importado (o aceite fica).
- `GET /me/academic/curriculum` → a grade do curso (currículo Ativo) marcada com o que a pessoa já fez: componentes obrigatórios,
  optativas e complementares com `state` (`DONE`, `DONE_VIA_EQUIVALENCE`, `ENROLLED`, `AVAILABLE`, `BLOCKED` + o que falta de
  pré-requisito), horas por natureza, `percentComplete`, atrasados e divergências. Sempre `estimate: true`. 404 `import_not_found`
  sem histórico gravado; 409 `curriculum_unavailable` enquanto a grade do curso não está pronta.

A fonte do PDF está ligada (fase 5): a importação baixa o "Histórico Escolar" pela sessão do SIGAA da pessoa (reaproveita o cookie guardado; a senha só é aberta se for preciso logar) em 2 requisições (portal e menu "Emitir Histórico"). A importação só existe com `ANTHROPIC_API_KEY` configurada (`available: false` sem ela). Falha da fonte vira `SIGAA_UNAVAILABLE` (SIGAA fora do ar, página inesperada) ou `SESSION_EXPIRED` (senha recusada).

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
