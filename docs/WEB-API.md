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
- `siasb.offered`: o SIASB é oferecido (a pessoa confirmou a importação da vida acadêmica, que grava a matrícula, e o SIASB lista ao menos um curso
  dela). Quem já tem conexão só precisa da matrícula importada, sem consultar o SIASB: se a importação for apagada
  (`DELETE /me/academic`), `offered` vira `false` e o `status` não muda. Falha ao consultar vale `false`, nunca derruba o `/me`.
- `siasb.status`: `connected`, `reconnect_required` ou `disconnected`. `reconnect_required` vem de uma conta marcada
  (o SIASB recusou o cookie) **ou** de `expiresAt` já no passado (cookie de 30 dias vencido).
- `siasb.expiresAt`: fim do cookie (ISO 8601); `null` se desconectado ou sem estimativa.
- `siasb.syncedAt`: último sucesso da sincronização da cópia (ISO 8601); `null` se nunca houve ou se desconectado.
- **Regra do painel (faixa de reconexão):** mostrar a faixa quando faltam 7 dias ou menos para `expiresAt`; `status === 'reconnect_required'` vale a qualquer momento, sem esperar os 7 dias.

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
| 422 | `siasb_credentials_rejected` | o SIASB recusou a matrícula ou a senha |
| 422 | `siasb_password_migration_required` | a pessoa precisa entrar uma vez no SIASB para atualizar a senha |
| 409 | `siasb_reconnect_required` | a conexão com o SIASB expirou ou foi recusada; a pessoa precisa reconectar no painel |
| 503 | `siasb_unavailable` | o SIASB não respondeu agora (fora do ar ou página inesperada) |
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

### SIASB (clínicas)

```
POST /connections/siasb   { "password": "string" }   → 204
DELETE /connections/siasb                            → 204
```

- A **matrícula não vai no corpo**: vem do perfil acadêmico da pessoa (gravado ao confirmar a importação da vida acadêmica). O web só oferece "Conectar SIASB" quando
  `connections.siasb.offered = true` e nunca pede a matrícula à mão.
- Faz 1 login real; o SIASB devolve o `username` da sessão, que precisa ser a matrícula da pessoa. A senha **não é
  guardada**: fica só o cookie do SIASB, cifrado, com a data de expiração (validade de 30 dias, fixa).
- Erros: `400 invalid_request` (sem matrícula: a vida acadêmica precisa estar importada), `409 source_account_mismatch` (a conta do SIASB não é da
  matrícula, ou a conta já está ligada a outra matrícula; recusado antes de falar com o SIASB quando o vínculo já
  existe), `409 source_account_taken` (matrícula de outra conta), `422 siasb_credentials_rejected`,
  `422 siasb_password_migration_required` (entrar uma vez no site do SIASB para atualizar a senha) e
  `503 siasb_unavailable`.
- `DELETE` apaga o cookie e a cópia sincronizada, e **mantém o vínculo** com a matrícula (para trocar, `DELETE /me`).

```
POST /connections/siasb/sync                          → 204
GET  /me/siasb/sessions?from=&to=                    → 200 { syncedAt, stale, items }
```

- `POST /connections/siasb/sync` ("Sincronizar agora"): sincroniza a cópia da pessoa na hora. Corpo `{}` (JSON). Erros: `404 not_found` (sem conta SIASB), `409 siasb_reconnect_required` (reconectar), `503 siasb_unavailable` (o SIASB não respondeu), `429 too_many_attempts` (mais de 3 por 10 minutos por pessoa). Uma sincronização já em curso conta como sucesso (204).
- `GET /me/siasb/sessions` (calendário do painel, lido da cópia, `Cache-Control: no-store`): `syncedAt` (ISO ou `null`), `stale` (`true` se nunca sincronizou, a última tentativa falhou ou o último sucesso tem mais de 3 h) e `items` (`id`, `attendanceId`, `disciplineName`, `startAt`, `endAt`, `locationName`, `professorName`, `patientFirstName`, `statusLabel`, `rescheduledStartAt`). `patientFirstName` é só o primeiro nome, decifrado para o dono; vazio se não puder ser lido. Padrão: de 14 dias atrás a 45 à frente. `400 invalid_request` se `from > to` ou o intervalo passa de 190 dias; `404 not_found` sem conta SIASB.
- `from` e `to` são instantes ISO 8601 com fuso, por exemplo `2026-11-15T00:00:00-03:00` ou terminando em `Z`; data sem hora ou sem fuso dá 400. Quando só `from` é enviado, `to` = agora + 45 dias; por isso um `from` anterior a cerca de 145 dias atrás passa de 190 dias e também dá 400.
- Detalhes da integração: `docs/SIASB.md`.

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
  `summary.programLabel` é o curso separado para a tela mostrar um título curto: `{ raw, name, unit, campus, degree, modality, shift, format }`. O texto do histórico é `NOME/UNIDADE - CAMPUS - GRAU - MODALIDADE - TURNO` (ex.: `ENGENHARIA DA COMPUTAÇÃO/EPOLI - SALVADOR - BACHARELADO - PRESENCIAL - N` → `Engenharia da Computação`, `EPOLI`, `Salvador`, `Bacharelado`, `Presencial`, `Noturno`). `raw` é sempre o texto original (igual a `summary.programName`, que continua). `format`: `full` (5 pedaços), `partial` (só os que existem, os demais `null`) ou `raw` (nada reconhecido: `name` é o texto original e o resto `null`). Grau, modalidade ou turno desconhecidos aparecem como vieram (turno: só `M`, `T`, `N`, `I` são traduzidos). A tela mostra `name` como título e os pedaços não nulos como detalhes; nunca deve esconder o curso. O parser é `src/domain/academic/program-label.ts`; formato fora do padrão gera UMA linha de aviso por processo (só o formato, nunca o texto do curso).
  `registration` é a matrícula do portal do SIGAA, gravada na confirmação (vem junto do `summary`, só com o histórico gravado; `null` se o portal não a trouxe; apagada por `DELETE /me/academic`). Só aparece para a própria pessoa, com sessão, e nunca vai ao provedor de IA. `summary` vem **sempre que há histórico gravado, em qualquer status** (inclusive `RUNNING`, `NEEDS_CONFIRMATION` e `FAILED` de um Atualizar): `summary !== null` significa "tem histórico gravado". `importedAt` é a data desse histórico enquanto o Atualizar roda, espera confirmação ou falha. `curriculumStatus` (a grade do curso): `NONE` | `READY` | `IMPORTING` | `UNAVAILABLE`.
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
- `DELETE /me/academic/draft` → 204. Descarta **só** o rascunho (`NEEDS_CONFIRMATION`) ou a falha (`FAILED`) de um Atualizar, sem tocar no histórico gravado: com histórico o estado volta a `READY`; sem, a `NONE`. 409 `import_in_progress` durante a leitura (`RUNNING`); 404 `import_not_found` sem rascunho nem falha.
- `GET /me/academic/curriculum` → a grade do curso (currículo Ativo) marcada com o que a pessoa já fez: componentes obrigatórios,
  optativas e complementares com `state` (`DONE`, `DONE_VIA_EQUIVALENCE`, `ENROLLED`, `AVAILABLE`, `BLOCKED` + o que falta de
  pré-requisito), `corequisiteExpr` (texto do co-requisito como o SIGAA imprime; o cumprimento não é calculado) e `responsibleUnit` (unidade responsável) em cada componente, ambos `string | null`, horas por natureza, `percentComplete`, atrasados e divergências. Sempre `estimate: true`.
  Para o **mapa da Trajetória** (`dev/ufba/handoffs/trajetoria-mapa.md`): `prerequisiteEdges` (`{ from, to, kind }`: `from` é pré-requisito de `to`; `kind` é `REQUIRED` quando a ligação é exigida em toda forma de cumprir a expressão e `ALTERNATIVE` quando faz parte de um OU; só ligações entre componentes do currículo; lista vazia quando o SIGAA não trouxe pré-requisitos legíveis) e, em cada componente, `lastAttempt` (`{ term, grade, status }` da tentativa que vale: a última aprovada, se houve, senão a última; `term` nulo nas linhas sem semestre; `null` se a pessoa nunca cursou o código) e `toRedo` (a última tentativa foi `REP`, `REPF`, `REPMF` ou `TRANC` e o componente não está cumprido nem em curso; o `state` segue `AVAILABLE` ou `BLOCKED`, a tela mostra "a refazer"). O caminho completo (tudo que o componente exige e libera, em qualquer profundidade) a tela calcula a partir de `prerequisiteEdges`. O currículo e o grafo ficam em cache na API (5 min, renovado na hora quando a importação grava). 404 `import_not_found`
  sem histórico gravado; 409 `curriculum_unavailable` enquanto a grade do curso não está pronta.

A fonte do PDF está ligada (fase 5): a importação baixa o "Histórico Escolar" pela sessão do SIGAA da pessoa (reaproveita o cookie guardado; a senha só é aberta se for preciso logar) em 2 requisições (portal e menu "Emitir Histórico"). A importação só existe com `ANTHROPIC_API_KEY` configurada (`available: false` sem ela). Falha da fonte vira `SIGAA_UNAVAILABLE` (SIGAA fora do ar, página inesperada) ou `SESSION_EXPIRED` (senha recusada).
## 5.2 Calendário acadêmico (alertas para admin)

Spec: `dev/ufba/handoffs/calendario-cron-e-alerta-admin.md`. Toda semana um **cron do Railway** (serviço próprio, `node dist/src/calendar-job.js`; ver `docs/CALENDARIO-CRON.md`) lê
`supac.ufba.br/calendario-academico`, acha os PDFs de calendário (o texto do link é o semestre) e, para arquivo novo ou
alterado (SHA-256), lê o PDF com a IA (Haiku 5.5, ~US$ 0,01) e confere por aritmética (dias letivos, marcos, datas). Cada arquivo
vira uma linha em `calendar_parse_logs`: `PUBLISHED` (verificado; é o calendário vigente do semestre), `NOT_VERIFIED` (não
publica) ou `ERROR`. Antes de registrar NOT_VERIFIED ou ERROR a API relê uma vez. Na primeira execução lê só o calendário mais
recente. Só roda com `ANTHROPIC_API_KEY`. A API não tem agendador: ela só mostra os alertas, reprocessa e entrega o calendário.

Só quem está em `ADMIN_EMAILS` (a mesma lista da memória): os outros recebem 403 `not_admin`.

- `GET /admin/calendar/alerts` → `{ items, expired }`. `items`: leituras `NOT_VERIFIED`/`ERROR` não vistas do semestre vigente ou
  futuro (`ERROR` da página inteira, sem `term`, sempre aparece), com `warnings` (avisos da conferência ou o motivo do erro).
  `expired`: o último calendário publicado já terminou e nada novo apareceu (`{ term, termEnd }`).
- `POST /admin/calendar/logs/{id}/seen` `{}` → 204. Marca "Visto" (guarda quem e quando); qualquer admin pode. 404 `not_found`.
- `POST /admin/calendar/logs/{id}/reprocess` `{}` → **202**. Botão "Reprocessar" da linha do alerta: baixa de novo a `sourceUrl`, ignora a idempotência por hash (com a releitura única de sempre) e atualiza a MESMA linha, mantendo "Visto": `PUBLISHED` se verificar, senão continua `NOT_VERIFIED`/`ERROR` com os avisos novos. Roda em segundo plano (leva até alguns minutos): a tela acompanha refazendo `GET /admin/calendar/alerts`. Erros: 404 `not_found`; 409 `calendar_log_not_reprocessable` (linha `PUBLISHED`, alerta da página inteira que não é de um arquivo, ou já em reprocessamento); 503 `calendar_unavailable` (sem chave da IA). Roda no serviço da API.

### Calendário publicado para o app

`GET /calendar[?term=2026.2]` → 200, qualquer pessoa com sessão (`no-store`). Sem `term`: o semestre vigente (o que contém hoje; entre dois semestres, o próximo a começar; passados todos, o mais recente). Reedição do mesmo semestre: vale a mais recente. 404 `not_found` se não há calendário publicado; `term` inválido é 400.
O corpo é o contrato fiel ao PDF, sem a conferência interna: `{ contractVersion: "1", sourceUrl, publishedAt, document: { term, publishedOn }, keyDates: { termStart, progress25, progress50, progress75, termEnd, internship }, events[], teachingDays: { byMonth[], total }, nonTeachingDays[], otherEvents[] }`. Toda data é ISO (`YYYY-MM-DD`); `when` é uma união por `type` (`on`, `between`, `until`, `from`, `undetermined`). A projeção em intervalos de dia ainda não existe.

## 5.2.1 Calendário do Painel (`GET /me/calendar`)

`GET /me/calendar?from=AAAA-MM-DD&to=AAAA-MM-DD` → 200 `MeCalendarResponse` (`no-store`, sessão normal). Compila tudo pronto para desenhar; o web **não** monta isso a partir de várias rotas. `from` e `to` (inclusivos, dias de Salvador, America/Bahia): ausentes, inválidos, invertidos ou com mais de **62 dias** = 400 `invalid_request`.

```
{ from, to, term: "2026.2" | null,
  days: [{ date, nonTeaching: { name } | null, items: Item[] }],     // só dias com algo, em ordem
  sources: [{ source: "sigaa"|"siasb", status: "ok"|"failed"|"reconnect_required" }] }
Item = { id, kind: "class"|"session", source: "sigaa"|"siasb", title, courseName|null, courseCode|null,
         startsAt, endsAt, place|null }                              // ISO com -03:00
```

**Só três coisas entram** (decisão do André): feriados e dias sem aula, aulas e sessões do SIASB. **Não há entregas nem provas** do Moodle/Classroom (a rota não chama essas fontes).

- **Feriados e dias sem aula:** do calendário acadêmico publicado (`nonTeachingDays`, intervalos expandidos e recortados no intervalo; de todos os calendários publicados, então um mês entre semestres também vem). `term` = o semestre que mais cobre o intervalo (empate: o mais novo); sem calendário: `null` e a rota segue.
- **Aulas (`kind: "class"`, `source: "sigaa"`):** a recorrência que o **próprio SIGAA aponta**: as linhas da tabela de turmas do portal do discente (a mesma página que `listar_cursos` lê, **1 requisição**, inclusive turmas sem Turma Virtual) trazem o horário, ex. `35T45 (18/08/2026 - 19/12/2026)`. Código: dígitos dos dias (1 domingo, 2 segunda … 7 sábado) + turno (`M`/`T`/`N`) + módulos; vários códigos na mesma célula (`2N12 4N34`) dividem um período só no fim; módulos não consecutivos viram faixas separadas (`2M136` = três faixas); **módulo que o turno não tem é ignorado sozinho** (`2N45` fica com o 4), sem derrubar o bloco. A API expande por dia dentro do **período da turma** (sem período no portal, vale o semestre do calendário; sem nenhum, nada é inventado) e **exclui os dias com `nonTeaching`**. `title`/`courseName` = nome da turma; `courseCode` só quando o portal traz `CODIGO - Nome` (o da UFBA costuma trazer só o nome: então `null`). `place` = o local **do dia**, em texto curto lido da coluna Local (texto livre do professor): `PAF 1 · 208`, `ENG`, `PAF II · Smart Class III` (sala diferente por dia vale); sem padrão conhecido, o texto original enxuto. A linha de cabeçalho de semestre (`2026.2`) marca as turmas. Horários dos módulos (`domain/academic/class-schedule.ts`): 55 min contínuos a partir de **07:00 (M1–M6), 13:00 (T1–T6) e 18:30 (N1–N4)**, ex. `35T45` = 15:45 às 17:35: a mesma tabela do app antigo (um teste compara módulo a módulo) e a que o próprio portal real imprime na coluna Local. A leitura segue as fixtures reais do app antigo (`portal-discente-turmas.html`).
- **Sessões do SIASB (`kind: "session"`):** só para quem tem o SIASB **conectado** (sem acesso ou sem conexão: nenhum item e o `siasb` nem entra em `sources`). Vêm da cópia sincronizada (nunca fala com o SIASB), só as **marcadas** (não as canceladas nem atendidas), com `title` fixo "Sessão na clínica", disciplina em `courseName` e o local em `place`. **Nenhum dado de paciente** (a leitura nem decifra nome). **Não são excluídas em feriado.** Cópia desatualizada: `siasb: failed` e as sessões guardadas continuam; conexão a refazer: `reconnect_required`.
- **`sources`:** `sigaa` aparece quando o SIGAA está conectado (`connected`): `ok`; sessão que precisa de senha/passkey (`locked`, `password_required`) ou conta recusada: `reconnect_required` (sem consultar o portal); erro ao ler o portal (página inesperada, fora do ar, mais de 20 s): `failed`. SIGAA desconectado: nem entra. Falha de uma fonte não derruba a rota. Sem nenhuma fonte: 200 só com feriados e `sources: []`.
- **Cache** em memória por pessoa, intervalo e estado do SIGAA, 3 min; resultado com falha parcial não é guardado.

## 5.3 Permissões por app (o que a pessoa libera para UM app fazer)

Permissões **por app** (cliente OAuth), marcadas **na tela de autorizar** e revogadas em **Apps autorizados**; **só a pessoa, pela sessão do painel**, concede e revoga (nenhuma ferramenta MCP altera permissões). Genéricas: valem para qualquer fonte; o SIASB é o primeiro uso. Texto de tela (título e descrição) vem da API; o web não escreve nada. Padrão **negado**.

- **Oferta:** `GET /authorize/requests/{id}` (com sessão) traz `permissions: OfferedPermission[]` (`null` sem sessão), na ordem do catálogo:
  `OfferedPermission = { key, source, title, description, risk: "low"|"high", available, unavailableReason: "source_not_connected" | null, granted }`. `granted` = já concedida a **este** app (o do pedido): a tela pré-marca e envia sempre o conjunto inteiro em `approve` (reautorizar não desliga o que já estava ligado). Os textos são neutros ("pelo app"): o app pode não ser o Claude.
  **Só aparecem permissões de fontes a que a pessoa tem acesso** (o SIASB só para quem tem matrícula de clínica ou conexão; senão a lista vem vazia). `available` = a fonte está conectada (em qualquer estado, inclusive reconectar). `risk: "high"` = o web pede confirmação antes de ligar (a API confia na escolha).
- **Concessão:** `POST /authorize/requests/{id}/approve` aceita `{ permissions?: key[] }`. Presente (mesmo `[]`): grava o conjunto **exato** para este cliente, trocando o que ele tinha. Ausente: não altera. Validado **antes** de qualquer efeito do pedido: chave fora do enum ou corpo inválido = 400 `invalid_request`; chave de fonte desconectada = 409 `permission_unavailable` (o pedido continua válido). Gravada depois de emitido o code.
- **Apps autorizados:** cada `AuthorizedApp` traz `permissions: { key, source, title, description, risk }[]` (o que a pessoa liberou para ESTE app). `DELETE /authorized-apps/{clientId}/permissions/{key}` → 204 retira **uma** sem revogar o app (404 se o app não a tinha; 400 chave inválida). Revogar o app leva as permissões dele.
- **Fonte desconectada:** as permissões dela somem de **todos** os apps (não ficam ligadas para uma conexão futura).
- **Filtro por acesso:** `GET /me/notification-settings` também devolve só os avisos de fontes a que a pessoa tem acesso (sem SIASB, lista vazia).
- Rotas que mudam estado exigem sessão, `X-UFBA: 1`, `Origin` da casa e JSON (DELETE sem corpo).

**Legado (`/me/permissions`, a remover):** `GET` devolve a oferta com `enabled` = concedida a **pelo menos um app** (`no-store`; vazio sem acesso). `PUT /me/permissions/{key}` `{ enabled }`: `false` retira a chave de todos os apps (204); `true` é 400 (a permissão é dada ao autorizar o app). Existe só para o web não ficar sem tela durante a troca.

Chaves: `siasb.schedule_write` (risco `low`: agendar e desmarcar sessões), `siasb.procedures_write` (risco `high`: lançar e excluir procedimentos previstos) e `moodle.forum_write` (risco `high`: postar em fóruns do AVA). Chave nova entra em `PERMISSION_KEYS` e em `PERMISSION_CATALOG` (`src/application/permissions/permissions.service.ts`: título, descrição, fonte e risco são obrigatórios por tipo).

Armazenamento: `client_permissions (user_id, client_id, key, granted_at)`, chave primária `(user_id, client_id, key)`; linha existe = concedida. `DELETE /me` apaga todas (cascade). A antiga `user_permissions` (por pessoa) foi **apagada** (migração `20261116210000`, que só derruba se estiver vazia; senão falha com mensagem clara) e não foi migrada: concessão por app exige consentimento explícito de cada app. Cada concessão/revogação vai para o log de auditoria sem dado clínico (`permissões do app: user=<id> app=<client> chaves=[...] em=<ISO>`, `permissão revogada: ...`).

**MCP:** o `/mcp` resolve as permissões **do app que chama** (o `clientId` do token) a cada requisição (`McpPrincipal.permissions`) e só registra uma ferramenta de escrita se a chave foi concedida a esse app (`registerPermissionedTool` em `mcp-tools.ts`); sem a chave a ferramenta nem aparece em `tools/list`. Conceder e revogar vale na próxima requisição. Credencial sem app (chave de API `plt_`) não tem nenhuma. Ferramentas de escrita registradas: `postar_forum` com `moodle.forum_write` e as quatro do SIASB (`clinica_agendar_sessao` e `clinica_desmarcar_sessao` com `siasb.schedule_write`; `clinica_incluir_procedimento` e `clinica_excluir_procedimento` com `siasb.procedures_write`), descritas em `docs/MCP.md` (e, as do SIASB, em `docs/SIASB.md`, seção 14).

## 5.5 Notificações (Web Push, canal genérico)

Qualquer fonte avisa pelo mesmo canal (`Notifier`); o SIASB é o primeiro uso. Detalhes de operação em `docs/NOTIFICACOES.md`. Todas as rotas são da sessão do painel; as que mudam estado exigem `X-UFBA: 1`, `Origin` da casa e JSON (`{}` quando não há dados).

- `GET /push/config` → `{ publicKey }` (`no-store`), a chave pública VAPID para `pushManager.subscribe`. Canal desligado (sem as variáveis VAPID): 503 `push_unavailable`.
- `POST /me/push-devices` `{ subscription: { endpoint, keys: { p256dh, auth } }, label? }` → 201 `{ id }`. **Idempotente por endpoint** (o mesmo aparelho de novo devolve o mesmo `id`). No máximo 10 por pessoa: 409 `too_many_devices`. O endpoint precisa ser de um serviço de push de navegador (FCM, Mozilla, Apple, Windows); outro host: 400 `invalid_request`. O mesmo navegador entrando em outra conta muda o aparelho de dono.
- `GET /me/push-devices` → `{ items: [{ id, label, createdAt, lastSuccessAt }] }` (`no-store`). **Nunca** devolve endpoint nem chaves.
- `DELETE /me/push-devices/{id}` → 204. Aparelho de outra pessoa ou inexistente: 404 `not_found` (igual nos dois casos).
- `POST /me/push-devices/{id}/test` `{}` → 204 (envia o aviso "Teste de aviso"). Se o provedor diz que a assinatura acabou (404/410), o aparelho é removido e a resposta é 409 `push_device_gone`. 5 por 10 minutos por pessoa: 429 `too_many_attempts`. Falha de envio sem ser "acabou": 503 `push_unavailable`.
- `GET /me/notification-settings` → `{ items: [{ key, source, title, description, enabled }] }` (`no-store`), textos pt-BR **da API** (o web não escreve texto de aviso). Sem linha no banco vale o `defaultEnabled` do catálogo.
- `PUT /me/notification-settings/{key}` `{ enabled }` → 204. `key` é o enum fechado `NOTIFICATION_KEYS`; chave desconhecida ou corpo inválido: 400.

Chave inicial: `siasb.alerts` ("Avisos do SIASB", padrão **ligada**). Chave nova entra em `NOTIFICATION_KEYS` (contrato) e em `NOTIFICATION_CATALOG` (`src/application/notifications/catalog.ts`). Códigos novos de erro: `push_unavailable` (503), `too_many_devices` (409), `push_device_gone` (409).

Armazenamento: `push_devices` (assinatura **cifrada** com a `SECRETS_KEY`, AAD `push:<userId>:<id>`; em claro só o sha256 do endpoint), `notification_settings (user_id, key, enabled)` e `alert_log` (anti-duplicata, chave única `(user_id, key, subject, slot_at)`). `DELETE /me` apaga tudo (cascade).

## 5.4 Abrir o SIGAA já logado (botão)

Origem: spike de 14/11/2026 (`dev/ufba/handoffs/spike-sigaa-resultado.md`). O id na URL (`;jsessionid=`) não sustenta a navegação, e o servidor não consegue gravar cookie do SIGAA no navegador. O que funciona é o **navegador enviar o login ao SIGAA** (POST de formulário em navegação de página inteira). **Decisão do André:** o aluno não digita a senha, e por isso ela passa pelo navegador, mas **nunca pelo JavaScript do painel**: ela existe só na resposta de uma navegação a uma página mínima da API.

1. `POST /connections/sigaa/launch` `{}` → 200 `{ launchUrl }` (`no-store`). Exige sessão, `X-UFBA`, `Origin` da casa e o SIGAA aberto **nesta** sessão (409 `source_not_connected`); no máximo 6 por 10 minutos por pessoa (429 `too_many_attempts`). O token da URL é aleatório, vale **30 s**, é de **uso único** e preso à pessoa e à sessão do painel que o pediu. Não toca o SIGAA e não carrega a senha.
2. O painel abre `launchUrl` numa **navegação de página inteira** (link com `target="_blank" rel="noopener"` ou `window.open`; **não** `fetch`).
3. `GET /sigaa/launch?t=<token>` (fora do contrato JSON; devolve HTML): só atende navegação (`Sec-Fetch-Mode: navigate` e `Sec-Fetch-Dest: document`, senão 403, sem gastar o token), com o cookie da própria sessão. A API gasta o token, abre a senha com a K da sessão, lê o formulário de login do SIGAA (anônimo) e devolve uma página que o envia sozinho a `https://sigaa.ufba.br/sigaa/logar.do?dispatch=logOn` em ISO-8859-1. Erros viram uma página curta em português (401 sessão vencida, 403 sessão errada, 409 SIGAA fechado, 410 link vencido ou já usado, 503 SIGAA fora do ar).
4. Cabeçalhos da página: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, CSP `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; form-action https://sigaa.ufba.br; frame-ancestors 'none'; base-uri 'none'` (nem um script injetado conseguiria mandar a senha para outro lugar).

O que continua exposto: a senha fica na resposta HTTP (sob TLS) e no DOM dessa página por milissegundos, visível a extensões do navegador com acesso à página. Auditoria: `sigaa-launch: user=<id> em=<ISO>`, nunca senha nem token. Cada clique cria uma sessão nova no SIGAA (por isso o limite); sair do SIGAA derruba só essa sessão, não a das consultas da API.

## 6. Autorizar um cliente de terceiros (ex.: Claude)

1. O cliente abre `GET {API}/authorize?…` (OAuth 2.1 + PKCE). A API valida cliente e `redirect_uri` e redireciona
   para `{AUTH}/authorize?request=<id>`. Pedido inválido (cliente desconhecido, `redirect_uri` não registrado) **não**
   redireciona para o cliente: vai para `{AUTH}/authorize/error?error=<code>&message=<texto>`.
2. O web pede os dados:

`GET /authorize/requests/{id}` → 200 `RequestInfo`.

- Funciona **sem sessão**: aí vem `signedIn: false` e `sources: null` (dá para mostrar "Claude quer acessar seus
  dados" antes do login). O web manda para `/sign-in?return=/authorize?request=<id>` e volta depois.
- `domain`: host do `redirect_uri`, sempre em ASCII (punycode). Mostrar em destaque, exatamente como vem.
- `local`: o `redirect_uri` volta para a **própria máquina** da pessoa (loopback `localhost`/`127.0.0.1`/`[::1]` ou esquema privado de app, como `cursor://`). **Não é verificação**: diz para onde o código vai, não quem é o cliente (qualquer programa local pode pedir `localhost` com o nome que quiser). A tela mostra algo como "Roda no seu computador", sem o selo de verificado.
- `verified`: o domínio está em `config/verified-apps.json`. Para cliente por documento de metadados (`client_id` = URL https), conta o **host do documento** (ex.: `claude.ai/oauth/claude-code-client-metadata` é verificado como "Claude" mesmo com redirect em `localhost`); para os demais, o domínio do `redirect_uri`.
- `name`/`logoUrl`: de `config/verified-apps.json` se o domínio for verificado e a entrada tiver; senão do
  documento de metadados do cliente (quando `client_id` é uma URL https); senão `null`. O `client_name` do
  `/register` é ignorado. Nome saneado (sem controle/bidi, até 60 caracteres). Logo servido pela própria API
  (PNG/JPEG/WebP até 256 KB; SVG recusado).
- `sources`: o acesso não é por escopo: o cliente lê todas as fontes conectadas da pessoa. SIGAA só vai junto se
  estiver `connected` nesta sessão. Inclui `siasb` (`connected`, `reconnect_required` ou `disconnected`) **só para quem tem acesso a ele**.
- `permissions`: as permissões que este pedido pode conceder (§5.3); `null` sem sessão.

3. Decisão:

```
POST /authorize/requests/{id}/approve   { permissions?: key[] }   → 200 { "redirectTo": "<redirect_uri>?code=…&state=…" }
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
- Revogar apaga os tokens do cliente, a senha do SIGAA cifrada para ele e as permissões dele (§5.3). Efeito imediato.
- Cada app traz `permissions` (o que a pessoa liberou para ele); `DELETE /authorized-apps/{clientId}/permissions/{key}` → 204 retira uma só.

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
