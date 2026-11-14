# Memória compartilhada na ufba.app (desenho)

Status: **proposta para aprovação do André**. Sem código. Autor: agente da API (Alicerce), 14/11/2026.
Base: ai-memory **v3.4.6** (`github.com/akitaonrails/ai-memory`, tag `v3.4.6`), lido em `docs/users.md`, `docs/self-service-keys.md`, `docs/install.md`, `docs/frontend-api.md`, `docs/design-per-project-authz.md`, `install.ps1` e o código do CLI (`crates/ai-memory-cli/src/commands/{api_key,user,grant,project}.rs`, `cli.rs`).

## 1. Objetivo e decisões já tomadas

Deixar a memória compartilhada (https://memory.ufba.app) acessível pela ufba.app, para o time de dev e, depois, para grupos de trabalho de alunos. **Sem IA no servidor, nunca.**

Decisões do André (não reabertas aqui):

1. Um MCP só para memória: o da ufba.app (`https://api.ufba.app/mcp`, OAuth com Google @ufba.br). Ele repassa as ferramentas do ai-memory com a credencial da pessoa e pode bloquear as destrutivas. Ninguém registra o MCP do ai-memory. Workspace e projeto vão explícitos em cada chamada.
2. Cada pessoa = um usuário no ai-memory, criado pela API na primeira vez, pela API administrativa do ai-memory (token root só no servidor, como `Secret`). Permissões por projeto e grupos ficam na ufba.app, que chama grant/revoke. Projetos nascem restritos (`AI_MEMORY_AUTH__NEW_PROJECTS_RESTRICTED=true`, já ligado).
3. Captura por hooks continua sendo do ai-memory oficial na máquina (fila offline, limpeza local, `[capture]` do `.ai-memory.toml`). Sem tradutor de hooks na API.
4. Um comando genérico de instalação (`irm https://ufba.app/install.ps1 | iex` e `curl -fsSL https://ufba.app/install.sh | sh`), com login de dispositivo (RFC 8628), uma chave por computador gravada direto na config do ai-memory, detecção de agentes, hooks e registro do MCP. Idempotente. Scripts abertos em `ufba-app/memory`, servidos pela ufba.app.
5. Painel: "Memória > Computadores conectados" e a página `/device` (Mosaico).
6. O MCP ensina o agente: `instructions`, `memory_connect_computer`, `memory_status` e um prompt `conectar computador`.

## 2. O que a documentação oficial confirma (e o que não)

| Pergunta | Resposta verificada na v3.4.6 | Impacto |
|---|---|---|
| Root cria usuário por API? | **Sim.** `POST /admin/human-users` `{username, name?, email?, role?}` (usado por `ai-memory user add-human`) devolve o usuário e uma **senha temporária** (`temporary_password`). Autenticação: bearer root (`AI_MEMORY_AUTH_TOKEN`). Não existe mais criação de usuário "só com chave" (o `user add` 1.x foi removido na 3.0). | A API cria o usuário como "humano" e **descarta a senha temporária** sem gravar nem logar. Ninguém entra no console web do memory por senha. Ver pergunta 6 do §13 e o ponto de spike S2. |
| Root emite mais de uma chave `aim_` para outro usuário? | **Sim.** `POST /admin/api-credentials` `{username, label}` devolve `{credential:{id,user_id,label,preview,created_at,last_used_at,expires_at,revoked_at}, token}`. O token aparece **uma vez**; o servidor guarda só `SHA-256(token ":" pepper)`. "One identity may hold several native keys with distinct labels" (`users.md`). | Uma chave por computador, com `label` = `pc:<id curto>:<nome>`. |
| Revogar só uma? | **Sim.** `POST /admin/api-credentials/{id}/revoke`. Também `POST .../{id}/rotate` (o texto antigo passa a dar 401 na hora) e `GET /admin/api-credentials` (metadados, `last_used_at`, nunca o segredo). | Revogar um computador não afeta os outros. `last_used_at` alimenta o painel. |
| Limite de chaves | Só documentado para as chaves **autosserviço** (20 ativas por usuário). Para `/admin/api-credentials` o limite **não está documentado**. | Spike S3. A API impõe o próprio teto (10 computadores ativos por pessoa) antes de chamar o memory. |
| Chaves autosserviço (`--enable-self-service-keys`) servem? | **Não.** Só aceitam **sessão humana de navegador** (cookie + CSRF); "machine bearers cannot use these routes". | Ficam desligadas. Usamos a rota de admin. |
| Chave `aim_` é administradora? | **Não.** Sempre `AuthLevel::User`, mesmo para dono root; `/admin/*` dá 403. | Vazar a chave de um computador não dá acesso administrativo. |
| Grants por projeto | **Sim.** `POST /admin/projects/access` `{workspace, project, mode: restricted\|open}`; `POST /admin/users/{username}/grant` `{workspace, project, level: read\|write}`; `POST /admin/users/{username}/revoke` `{workspace, project}`; `GET /admin/users/{username}/grants`; `GET /admin/projects/grants`. Tudo root-only; cada operação vai para o audit log (`grant_access`/`revoke_access`). Quem cria o projeto fica como criador e mantém acesso total. | A ufba.app é a única que chama grant/revoke. |
| Proxy de identidade (`X-Memory-Actor-*`) serve para repassar a pessoa? | **Não.** O doc é explícito: um usuário vindo por proxy "is not subject to per-project `restricted` grants" (a restrição não se aplica a identidade por cabeçalho). | **Rejeitado.** Para o grant valer, o repasse do MCP precisa usar **chave `aim_` de usuário do banco**. |
| Cliente local para servidor remoto | `AI_MEMORY_SERVER_URL` e `AI_MEMORY_AUTH_TOKEN` (ou `--server-url`/`--auth-token`). `install.md` tem o passo a passo remoto: `ai-memory install-hooks --agent claude-code --apply` com essas variáveis, **sem** `setup` nem servidor local. `server_url` também pode ficar em `config.toml`. | Instalador usa variáveis de ambiente só no processo filho. |
| Onde a chave fica | `install-hooks --apply --auth-token …` grava em `<data_dir>/auth-token` e `<data_dir>/auth-header`, ambos `0600` (data dir `0700`); **não** vai para o arquivo de config do agente (desde #552, para não aparecer em `/proc/<pid>/cmdline`). `--auth-token` na linha de comando tem precedência sobre o arquivo. | Preferir `AI_MEMORY_AUTH_TOKEN` no ambiente do processo filho a `--auth-token` (a flag aparece na lista de processos durante a instalação). Spike S1 confirma que a variável basta. |
| Hooks sem interação | `install-hooks --agent <x> --apply` é idempotente, preserva config alheia e faz backup. `setup --yes --agent <x>` é a forma "completa" mas cria **servidor local, serviço e root bearer local**: **não serve**. | Usar `install-hooks --apply` direto. Agentes suportados (enum `AgentChoice`): `claude-code`, `codex`, `cursor`, `gemini-cli`, `opencode`, `opencode2`, `pi`, `omp`, `openclaw`, `antigravity-cli`, `grok` e outros. |
| Config por conta (`CLAUDE_CONFIG_DIR`) | Suportado: com a variável definida, `install-mcp` grava em `$CLAUDE_CONFIG_DIR/.claude.json` e `install-hooks` em `$CLAUDE_CONFIG_DIR/settings.json`. | Rodar o instalador uma vez por diretório de config detectado (Maestri). |
| Instalar o binário | `install.ps1`/`install.sh` oficiais aceitam `AI_MEMORY_VERSION=3.4.6`, verificam `.sha256` (do mesmo origin da zip) e **recusam um destino já existente**. | O nosso instalador checa `ai-memory --version` antes: se já é 3.4.6, não reinstala; se é outra, usa `ai-memory upgrade`/reinstalação controlada. Fixamos o SHA-256 do artefato dentro do instalador (ver §8). |
| Atribuição | `pages.author_id` e o audit log carregam o usuário; páginas são compartilhadas **dentro** do projeto (sem RBAC por página); handoffs e sessões têm dono. | Quem está no projeto lê tudo do projeto. Sinalizar na tela de grupos. |

**Não existe** (e a alternativa): REST para listar todas as ferramentas MCP por usuário (usamos `tools/list` do próprio `/mcp` com a chave da pessoa); chave com validade configurável na criação (o JSON tem `expires_at`, mas a criação só recebe `username` e `label`; a expiração fica por nossa conta, via rotação/revogação, §8); modo "só chave, sem humano" (alternativa: criar humano e descartar a senha, ou desativar o login humano depois, ponto S2).

## 3. Arquitetura

```
 Computador do aluno/dev                     ufba.app (Railway)                         memory.ufba.app
┌──────────────────────────┐        ┌────────────────────────────────┐        ┌───────────────────────┐
│ agente (Claude Code,...) │─OAuth─▶│ api.ufba.app  /mcp              │─aim_──▶│ ai-memory v3.4.6      │
│                          │  MCP   │  ├ ferramentas da casa          │ (proxy │  usuários, grants,    │
│ ai-memory (oficial)      │        │  ├ proxy de memory_* (filtrado) │  key)  │  projetos restritos   │
│  hooks + fila offline    │──aim_──┼──────────────────────────────── ┼───────▶│  /hook, /mcp          │
│  chave POR COMPUTADOR    │ direto │  OAuth: authorize/token/device  │        │  /admin/* (root)      │
└──────────────────────────┘        │  /web/memory/*  (painel)        │─root──▶│                       │
        ▲ instalador                │  Postgres: grupos, computadores │ (só a  └───────────────────────┘
        │ (irm | iex)               └────────────────────────────────┘  API)
        └──── ufba.app/device (Mosaico) ◀── aprovação com sessão do Google
```

Duas credenciais **diferentes** por pessoa no ai-memory, de propósito:

- **Chave de computador** (`label` `pc:…`): uma por máquina, mostrada uma vez ao instalador, gravada pelo próprio ai-memory na máquina. **A API não a guarda** (só `credentialId`, prévia e metadados). Usada só por hooks, direto no `memory.ufba.app`. Revogar um computador revoga só ela.
- **Chave de repasse** (`label` `ufba-proxy`): uma por pessoa, criada junto com o usuário, **guardada cifrada na API** (`SECRETS_KEY`, como os tokens do Moodle/Google). Usada só pelo proxy do MCP em nome da pessoa. Não passa pelo token OAuth do cliente (diferente da senha do SIGAA, aqui não há razão para a chave K: o conteúdo é memória de trabalho, não credencial da UFBA, e o servidor precisa chamar sem a pessoa presente para grants/status).

Por que uma de repasse separada: o proxy precisa de uma credencial que a API possa usar a qualquer momento, e a chave de computador, por desenho, nunca fica na API. Se a de repasse vazar do banco, ela só vale com a `SECRETS_KEY` e nunca é admin; rotação por pessoa é uma chamada (`rotate`).

**O que o servidor ai-memory nunca recebe da ufba.app:** senha do SIGAA, tokens de Moodle/Google, nada das fontes. Memória é o que o agente da pessoa escreve.

## 4. Fluxos

### 4.1 Primeiro uso (a pessoa nunca viu o memory)

1. A pessoa autentica o Claude (ou outro cliente MCP) na ufba.app pelo OAuth que já existe.
2. Primeira chamada a qualquer ferramenta `memory_*` (ou `memory_status`): `MemoryUsers.ensure(userId)`:
   - lê `memory_users`; se não existe: `POST /admin/human-users` com `username = u<12 hex do userId>` (estável, sem PII), `name` e `email` conforme decisão da pergunta 5; **descarta `temporary_password`**;
   - `POST /admin/api-credentials {username, label:"ufba-proxy"}`; grava o token cifrado;
   - grava `memory_users` na mesma transação lógica, com `status` (`creating` → `ready`) para ser retomável se cair no meio (a criação no memory é idempotente por `username`: se já existe, só falta a chave).
3. O proxy chama o ai-memory com a chave de repasse. Sem grants, a pessoa vê só projetos abertos/próprios; projetos restritos respondem 403 nomeando o projeto e o nível (comportamento do ai-memory, o agente repassa a mensagem).
4. `memory_status` diz "nenhum computador conectado" e o agente oferece `memory_connect_computer` (§7).

### 4.2 Login de dispositivo (instalador)

RFC 8628, no nosso servidor OAuth. Cliente público `ufba-installer` (criado no boot como o `ufba-web`), escopo único `memory:connect`.

1. Instalador: `POST {API}/oauth/device_authorization` (`client_id=ufba-installer&scope=memory:connect`, e opcionalmente `computer_name`, `os`). Resposta: `device_code` (opaco, 256 bits), `user_code` (`XXXX-XXXX`), `verification_uri` (`https://ufba.app/device`), `verification_uri_complete`, `expires_in: 600`, `interval: 5`.
2. Instalador mostra o código, tenta abrir o navegador (`verification_uri_complete`) e começa a consultar `POST /token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) a cada `interval` segundos. Respostas padrão: `authorization_pending`, `slow_down` (+5 s), `access_denied`, `expired_token`.
3. Na `/device` (Mosaico): se a pessoa não tem sessão, entra com Google @ufba.br (fluxo de `ufba-web` existente). Digita ou confirma o `user_code`; a página chama a API (`POST /web/device/lookup`) e mostra **quem pediu**: nome do computador, sistema, hora, país/IP aproximado, o que será concedido ("gravar memória desta máquina") e aviso "só aprove se o código apareceu no SEU terminal agora". Botões Aprovar/Negar (`POST /web/device/decision`).
4. Aprovado: o próximo `POST /token` devolve um **access token curto** (10 min, uso único para o passo 5, escopo `memory:connect`, **sem a chave K**, não abre SIGAA nem o MCP geral) e **sem refresh**.
5. Instalador: `POST {API}/memory/computers` com `Authorization: Bearer <token curto>` e `{name, os, computer_id?}`. A API garante `ensure(userId)`, aplica o teto, `POST /admin/api-credentials {username, label:"pc:<idcurto>:<nome>"}` e devolve `{computer_id, memory_url, username, key}` (a chave **uma vez**, `Cache-Control: no-store`). Se veio `computer_id` já conhecido e dono = mesma pessoa, a API faz `rotate` da credencial dele (reinstalação), em vez de criar outra.
6. Instalador grava a chave (§6) e consome o token (a API invalida o token curto na primeira chamada de sucesso).

### 4.3 Chamada de ferramenta (proxy)

1. Cliente MCP → `POST /mcp` com o access token OAuth (já existente). A API resolve o usuário.
2. `tools/list`: ferramentas da casa + ferramentas do ai-memory que passam pelo filtro (§7.2). O catálogo do ai-memory vem de `tools/list` real com a chave de repasse, cacheado por 5 min por versão do servidor (`GET /healthz`/`initialize` informa a versão); se o memory estiver fora, as ferramentas da casa continuam e as `memory_*` somem com um aviso em `memory_status`.
3. `tools/call` de `memory_*`: a API valida o nome contra a lista permitida, repassa **o corpo sem alteração** com a chave de repasse e devolve a resposta. Workspace e projeto explícitos: a API **não** deduz escopo (o `/mcp` da casa é sem sessão, e o auto-scope do ai-memory depende de sessão/hook). Erro 403 do memory vira erro MCP legível ("sem acesso ao projeto X; peça ao dono do grupo").
4. Nada do conteúdo da chamada vai para log. Só: usuário (id), nome da ferramenta, workspace/projeto, status, latência.

### 4.4 Revogação

- **Um computador:** `DELETE /web/memory/computers/{id}` → `POST /admin/api-credentials/{credentialId}/revoke` → marca `revoked_at`. Hooks desse computador passam a receber 401 e **param de capturar** (a fila local envelhece sem travar; doc #493). Os outros computadores e o MCP seguem.
- **Pessoa inteira** (`DELETE /me` já existente): revoga todas as chaves (`pc:` e `ufba-proxy`), remove grants e `POST /admin/users/{username}/disable`; o registro no memory fica para manter a atribuição histórica das páginas (a doc diz que `author_id` continua resolvendo). Ver pergunta 7.
- **Saída de grupo/projeto:** §4.5. Sempre `revoke` explícito; a chave de computador não muda (o acesso é do usuário, não da chave).

### 4.5 Grupos

Fonte da verdade na ufba.app (`desired state`); o ai-memory só reflete.

- Tabelas: `memory_groups`, `memory_group_members`, `memory_projects`, `memory_grants` (§5).
- Um grant tem **sujeito** (grupo ou pessoa) e **nível** (`read`/`write`) sobre um projeto. O nível efetivo de uma pessoa = o maior entre os grants diretos e por grupo.
- **Reconciliação** (idempotente, ao mudar membros/grants e por varredura de 10 min): calcula, por pessoa, os projetos com nível efetivo; compara com `GET /admin/users/{username}/grants`; emite `grant`/`revoke` só do que diverge. Falhas ficam em `memory_sync_jobs` com retentativa e backoff; a tela mostra "sincronizando".
- **Criar projeto:** a API cria o projeto no memory (primeira escrita com chave do dono cria; já nasce `restricted`, e a API reforça com `POST /admin/projects/access {mode:"restricted"}` como cinto e suspensório). Dono = quem criou; só ele e `root` administram.
- **Ressalvas de modelo do ai-memory** (mostrar na tela): quem tem acesso lê **todas** as páginas do projeto (sem RBAC por página); handoffs são do dono; não existe "administrador de projeto" no memory, então a administração é sempre da API.

## 5. Modelo de dados novo (Postgres/Prisma)

Pasta nova `prisma/models/memory/`. Identificadores em inglês.

```prisma
model MemoryUser {
  userId           String   @id @map("user_id") @db.Uuid
  memoryUsername   String   @unique @map("memory_username")      // u<12 hex>, sem PII
  status           String                                         // creating | ready | disabled
  proxyCredentialId String? @map("proxy_credential_id")           // id no ai-memory
  proxyKeyEnc      Bytes?   @map("proxy_key_enc")                 // cifrado com SECRETS_KEY
  createdAt        DateTime @default(now()) @map("created_at")
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  computers        MemoryComputer[]
  @@map("memory_users")
}

model MemoryComputer {
  id            String    @id @default(uuid(7)) @db.Uuid
  userId        String    @map("user_id") @db.Uuid
  name          String                                            // "notebook-do-joao", editável
  os            String                                            // windows | macos | linux
  credentialId  String    @map("credential_id")                   // id no ai-memory (NUNCA a chave)
  keyPreview    String?   @map("key_preview")                     // prévia que o memory devolve
  agents        String[]                                          // detectados no último install
  clientVersion String?   @map("client_version")                  // versão do instalador
  createdAt     DateTime  @default(now()) @map("created_at")
  lastSeenAt    DateTime? @map("last_seen_at")                    // vem de last_used_at do memory
  revokedAt     DateTime? @map("revoked_at")
  user          MemoryUser @relation(fields: [userId], references: [userId], onDelete: Cascade)
  @@index([userId, revokedAt])
  @@map("memory_computers")
}

model DeviceAuthorization {                                       // RFC 8628; tudo curto (10 min)
  deviceCodeHash String   @id @map("device_code_hash")            // SHA-256
  userCodeHash   String   @unique @map("user_code_hash")          // SHA-256 do código normalizado
  clientId       String   @map("client_id")
  scope          String
  computerName   String?  @map("computer_name")                   // sugestão do instalador (não confiável)
  os             String?
  requestIp      String?  @map("request_ip")                      // só para exibir país/aviso; ver §8
  status         String                                           // pending | approved | denied | consumed
  userId         String?  @map("user_id") @db.Uuid
  intervalSec    Int      @default(5) @map("interval_sec")
  lastPolledAt   DateTime? @map("last_polled_at")
  failedLookups  Int      @default(0) @map("failed_lookups")
  expiresAt      DateTime @map("expires_at")
  @@index([expiresAt])
  @@map("device_authorizations")
}

model MemoryGroup {
  id        String   @id @default(uuid(7)) @db.Uuid
  name      String
  kind      String                                                // team | coursework
  ownerId   String   @map("owner_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  members   MemoryGroupMember[]
  grants    MemoryGrant[]
  @@map("memory_groups")
}

model MemoryGroupMember {
  groupId String @map("group_id") @db.Uuid
  userId  String @map("user_id") @db.Uuid
  role    String                                                  // owner | member
  addedAt DateTime @default(now()) @map("added_at")
  group   MemoryGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  @@id([groupId, userId])
  @@map("memory_group_members")
}

model MemoryProject {
  id        String @id @default(uuid(7)) @db.Uuid
  workspace String
  project   String
  ownerId   String @map("owner_id") @db.Uuid
  grants    MemoryGrant[]
  @@unique([workspace, project])
  @@map("memory_projects")
}

model MemoryGrant {                                               // sujeito = grupo OU pessoa
  id        String  @id @default(uuid(7)) @db.Uuid
  projectId String  @map("project_id") @db.Uuid
  groupId   String? @map("group_id") @db.Uuid
  userId    String? @map("user_id") @db.Uuid
  level     String                                                // read | write
  project   MemoryProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  group     MemoryGroup?  @relation(fields: [groupId], references: [id], onDelete: Cascade)
  @@map("memory_grants")                                          // CHECK: exatamente um de groupId/userId
}

model MemorySyncJob {                                             // fila de reconciliação com o memory
  id        String   @id @default(uuid(7)) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  attempts  Int      @default(0)
  nextRunAt DateTime @map("next_run_at")
  lastError String?  @map("last_error")                           // só código/status, nunca corpo
  @@index([nextRunAt])
  @@map("memory_sync_jobs")
}
```

Notas: `DeviceAuthorization` e tokens curtos são limpos por varredura (`expiresAt`). `DELETE /me` apaga em cascata e dispara a revogação no memory antes. Tabelas novas entram na migração do `prisma migrate deploy` do Dockerfile.

## 6. Endpoints novos (contrato)

Convenção do repo: rotas do app web entram no `contract.ts` (Zod) e no `openapi.json`; **mudança de contrato avisa o Mosaico (web)**. OAuth e as rotas do instalador ficam fora do contrato (`OUTSIDE_CONTRACT`), documentadas aqui.

### 6.1 OAuth (fora do contrato)

| Rota | Descrição |
|---|---|
| `POST /oauth/device_authorization` | Corpo `application/x-www-form-urlencoded`: `client_id`, `scope`, opcionais `computer_name`, `os`. Responde campos do RFC 8628. Só o cliente `ufba-installer` e só `memory:connect`. |
| `POST /token` (já existe) | Ganha `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Erros padrão do RFC. |
| `/.well-known/oauth-authorization-server` | Passa a listar `device_authorization_endpoint` e o novo `grant_type`. |

### 6.2 Instalador (fora do contrato; Bearer = token curto de dispositivo)

| Rota | Descrição |
|---|---|
| `POST /memory/computers` | `{name, os, computer_id?, agents?, client_version?}` → `{computer_id, username, memory_url, key}` (chave **uma vez**, `no-store`). Idempotente por `computer_id`. 409 `computer_limit_reached`. |
| `GET /memory/install-manifest` | Versão fixa do ai-memory, URLs e SHA-256 dos artefatos por plataforma, versão mínima do instalador. Público, cacheável. |

### 6.3 App web (no contrato, cookie de sessão, regras de CSRF atuais)

| Rota | Descrição |
|---|---|
| `POST /web/device/lookup` | `{user_code}` → `{client_name, computer_name, os, requested_at, approx_location}`; conta tentativa errada (§8). |
| `POST /web/device/decision` | `{user_code, decision: "approve"\|"deny"}`. |
| `GET /web/memory/status` | `{memory_available, user_ready, computers:[…], groups:[…], projects:[…]}`. |
| `GET /web/memory/computers` | `[{id,name,os,agents,created_at,last_seen_at,revoked_at}]`. |
| `PATCH /web/memory/computers/{id}` | `{name}`. |
| `DELETE /web/memory/computers/{id}` | Revoga (§4.4). Sem corpo. |
| `GET/POST /web/memory/groups`, `GET/PATCH/DELETE /web/memory/groups/{id}` | CRUD de grupos. |
| `PUT/DELETE /web/memory/groups/{id}/members/{userEmail}` | Convite por e-mail @ufba.br (só quem já tem conta); papel `owner`/`member`. |
| `GET/POST /web/memory/projects`, `PUT/DELETE /web/memory/projects/{id}/grants/{subject}` | Projetos e níveis. |

Novos códigos em `API_ERROR_CODES`: `device_code_invalid`, `device_code_expired`, `computer_limit_reached`, `memory_unavailable`, `memory_forbidden`, `group_not_found`, `not_group_owner`. Textos (`message`) em pt-BR; identificadores em inglês.

## 7. MCP: ferramentas, `instructions` e filtro

### 7.1 `instructions` do servidor (no `initialize`)

Texto proposto (pt-BR; entra em `instructions`, curto):

> "Este servidor também dá acesso à memória compartilhada da equipe (ferramentas `memory_*`). Sempre informe `workspace` e `project` explicitamente. A memória guarda o que você escreve; nunca grave senhas, tokens ou dados pessoais de outras pessoas. Existe captura automática das sessões quando o computador da pessoa está conectado. Chame `memory_status` no começo de uma conversa em que a memória seja relevante. Se não houver computador conectado e a pessoa quiser captura automática, ofereça `memory_connect_computer`. Nunca execute comandos de instalação sem pedir permissão antes."

### 7.2 Ferramentas

| Ferramenta | Comportamento |
|---|---|
| `memory_status` | Sem parâmetros. Lê **do servidor** (nunca confia no agente): `{memory_available, user_ready, connected_computers:[{name, os, last_seen}], hint}`. `last_seen` vem de `last_used_at` do memory (a chamada `GET /admin/api-credentials` filtrada pelo usuário). Quando não há computador: `hint` "Nenhum computador conectado. Ofereça `memory_connect_computer`". |
| `memory_connect_computer` | Parâmetro `os` opcional (`windows`\|`macos`\|`linux`). Devolve o passo a passo **como texto**: o comando de uma linha do sistema, o que ele faz (lista curta e honesta: instala o ai-memory v3.4.6, abre o navegador para aprovar, grava a chave, instala hooks, registra este MCP), o aviso "peça permissão à pessoa **antes** de rodar" e a alternativa "se este cliente não tem terminal, mostre o comando para a pessoa colar". Também devolve o link `https://ufba.app/memory/computers`. **Não executa nada e não devolve segredo.** |
| prompt `conectar computador` | Prompt MCP (vira `/mcp__ufba__conectar-computador` no Claude Code): instrui o agente a chamar `memory_status`; se faltar conexão, chamar `memory_connect_computer`, explicar em 3 linhas, pedir confirmação e só então rodar o comando. |
| `memory_*` do ai-memory | Repassadas pelo proxy conforme o filtro. |

### 7.3 Filtro do proxy

- **Lista de permissão por nome, padrão negar.** Ferramenta nova do ai-memory (nova versão) não aparece até alguém classificá-la; o teste de contrato falha se o `tools/list` do memory tiver nome não classificado, para forçar a revisão a cada atualização de versão.
- Classes: `read` (sempre), `write` (permitida, é o uso normal), `destructive` (apagar página, `reset`, esquecer em massa: **bloqueada**), `host` (ferramentas que escrevem/instalam na máquina, como `memory_install_self_routing`: **bloqueada**, porque a instalação é do nosso instalador), `admin` (nunca aparece; a chave de repasse é de usuário e o memory já dá 403).
- A classificação exata dos nomes é tarefa da etapa 0 (S5), com a lista real do `tools/list` da v3.4.6; não listo nomes aqui para não inventar.
- O repasse não altera argumentos nem resultado. Limites: corpo máximo 1 MB por chamada, timeout 30 s, 30 chamadas/min por pessoa.

## 8. Segurança

### 8.1 Onde fica cada segredo

| Segredo | Onde fica | Como |
|---|---|---|
| Token root do ai-memory | Variável do serviço `api` no Railway (`MEMORY_ROOT_TOKEN`) | `Secret.of`; só o módulo `MemoryAdminClient` chama `reveal()`; nunca em log/erro/resposta. Também no `.env` de dev (só nomes aparecem nas conversas). Não vale `*.up.railway.app`: usar a URL pública do memory. |
| Chave de repasse (`ufba-proxy`) | Postgres, `memory_users.proxy_key_enc` | Cifrada com `SECRETS_KEY` (mesma cifra dos tokens do Moodle). `reveal()` só na chamada ao memory. |
| Chave de computador (`aim_`) | **Só na máquina**: `<data_dir>/auth-token` e `auth-header`, `0600`, pasta `0700` (o ai-memory grava) | A API só tem `credentialId` e a prévia. Mostrada uma vez ao instalador (HTTPS, `no-store`). Nunca em log do instalador. |
| `device_code` / `user_code` | Banco, só **hash SHA-256** | Códigos em claro só no instalador e na tela da pessoa. Nunca em log (a rota de lookup é `POST` para o código não ficar em URL/log de acesso; o `verification_uri_complete` leva o código na URL, então o web troca para `POST` e limpa a URL com `history.replaceState`). |
| Token curto do instalador | Banco, hash | 10 min, uso único, sem refresh, sem K. |
| Pepper e chaves do ai-memory | Fora do nosso escopo (ficam no serviço do memory) | **Não girar o `token_pepper` do memory depois de emitir chaves** (invalida todas as `aim_`). |

Entram no teste canário (`test/secret-canary.spec.ts`): token root, chave de repasse, chave de computador, `device_code`, `user_code`, token curto. O canário percorre o fluxo de dispositivo e o proxy com valores marcados e falha se algum aparecer em saída/log.

### 8.2 Código de dispositivo: expiração e abuso

- `device_code`: 256 bits aleatórios, expira em **10 min**, uso único; após o resgate, `consumed`.
- `user_code`: 8 caracteres de um alfabeto sem ambiguidade (`BCDFGHJKLMNPQRSTVWXZ`, 20 símbolos → 20^8 ≈ 2,6×10^10), exibido `XXXX-XXXX`, comparação por hash, expira junto.
- Polling: respeita `interval`; mais rápido que isso → `slow_down`; passou de 10 min → `expired_token`. Limite de 120 consultas por `device_code`.
- Palpite de `user_code`: máx. **5 lookups errados por sessão e 20 por IP a cada 10 min**; excedeu → bloqueio temporário e o código ativo mais recente da sessão expira. Lookup só com sessão de usuário logado (sem sessão, não há como testar códigos).
- Confirmação explícita com contexto (nome, sistema, hora, localização aproximada) para reduzir phishing de "aprovar o dispositivo de outra pessoa" (o ataque clássico do device flow: a vítima digita o código que o atacante mostrou). Mitigação extra: se a aprovação chega **de um IP muito distinto** do `request_ip` do instalador, a tela destaca o aviso. Não bloqueamos.

### 8.3 Rate limit

| Rota | Limite |
|---|---|
| `/oauth/device_authorization` | 10/h por IP; 20 códigos ativos globais por IP |
| `/token` (device) | pelo `interval`, mais 120 por `device_code` |
| `POST /memory/computers` | 5/h por pessoa; teto de **10 computadores ativos** por pessoa (a API barra antes de pedir ao memory) |
| `/web/device/*` | §8.2 |
| Proxy `memory_*` | 30/min por pessoa; 1 MB por chamada |
| Criação de usuário no memory | 1 por pessoa (idempotente por `username`) |

### 8.4 O que nunca vai para log

Chaves `aim_`, token root, `device_code`, `user_code`, tokens, corpo de qualquer chamada `memory_*` (é conteúdo de trabalho da pessoa), corpo de `human-users` (a senha temporária), `Authorization`. Logamos: id do usuário, id do computador, nome da ferramenta, workspace/projeto, status HTTP, latência, códigos de erro. O `MemoryAdminClient` captura erros do `fetch` e relança sem a resposta crua.

### 8.5 `irm | iex` e `curl | sh`: riscos e mitigação

Riscos reais: (a) comprometer `ufba.app` ou o repositório troca o script de todo mundo; (b) um atacante no caminho (rede hostil, DNS) substitui o script; (c) o usuário executa sem ler; (d) o instalador roda com os direitos do usuário (acessa chaves SSH, etc.); (e) o script, se truncado, executa pela metade.

Mitigações propostas:

1. **Bootstrap pequeno** (≤ 80 linhas) servido por `ufba.app/install.ps1|sh`, que só faz: baixar o instalador **versionado e imutável** de uma URL de release do `ufba-app/memory` (GitHub Releases, outro origin), **verificar o SHA-256 embutido no bootstrap** (o bootstrap é gerado por CI a cada release com o hash dentro) e executá-lo. Comprometer só o GitHub ou só a ufba.app não basta; comprometer os dois ou o CI basta (risco residual aceito, como em qualquer projeto aberto).
2. Todo o corpo dentro de uma função chamada na última linha (um download truncado não executa nada), como o `install.ps1` oficial faz; HTTPS obrigatório; TLS 1.2+ no PowerShell 5.1.
3. **Binário do ai-memory:** versão **fixa** (3.4.6) e **SHA-256 do zip/tar fixado no manifesto** da ufba.app (não o `.sha256` do mesmo origin do binário, que o doc oficial admite não provar nada contra quem controla o origin).
4. `--dry-run` / `-WhatIf` (mapeia para `ai-memory setup --plan`/plano nosso): mostra o que mudaria sem tocar em nada. Instalador **só escreve** em: pasta do ai-memory, config dos agentes (com backup do próprio ai-memory), `~/.ufba/computer.json` (sem segredo). Lista no README.
5. Alternativa documentada para quem não confia em `| iex`: baixar o script, ler, conferir o hash publicado, rodar. O comando "genérico" que o MCP devolve é a versão curta; a versão "baixar e conferir" fica na página `ufba.app/instalar`.
6. Assinatura dos releases com minisign (chave pública no bootstrap e no repositório). Etapa posterior (§12, etapa 7).
7. Nada de `sudo`/admin; sem execução de código remoto depois da verificação; o instalador não envia telemetria.

## 9. O instalador (repo `ufba-app/memory`)

Entregáveis do repo: `install.ps1`, `install.sh` (bootstrap), `installer/` (Node-free: PowerShell e POSIX sh; sem dependências), `manifest` gerado por CI, testes em runners Windows/Linux/macOS, README com a lista do que muda na máquina. Licença AGPL-3.0.

Passos (idempotentes, cada um verifica antes de agir):

1. **Pré-checagem:** SO/arquitetura; conectividade com `api.ufba.app` e `memory.ufba.app`; modo `--dry-run`.
2. **ai-memory oficial na versão do manifesto:** se `ai-memory --version` = fixa, pula; senão instala (o script oficial recusa destino existente, então checamos antes) com SHA-256 do manifesto.
3. **Login de dispositivo** (§4.2). Em shell sem navegador, mostra o link e o código para a pessoa abrir em outro aparelho.
4. **Detectar agentes:** `claude` (e config dirs), `codex`, `gemini`, `opencode`, `cursor`, etc. (presença no PATH e diretórios de config). **Claude Code por conta:** além de `~/.claude`, varrer **só** os diretórios de config conhecidos do Maestri (a confirmar com o Mosaico/Maestri onde ficam; a pasta de memória deste agente mostra `~\.maestri-local\accounts\<id>`) e rodar o passo 5 com `CLAUDE_CONFIG_DIR=<dir>` para cada um. Nunca varrer o disco; lista fechada de locais.
5. **Instalar hooks, por agente:** `ai-memory install-hooks --agent <x> --apply` com `AI_MEMORY_SERVER_URL=https://memory.ufba.app` e `AI_MEMORY_AUTH_TOKEN=<chave>` **somente no ambiente do processo filho** (a chave nunca vai em argumento, no log nem em arquivo nosso). O ai-memory grava `auth-token`/`auth-header` `0600`. Opcional `--as-user <username>` (metadado). Uma chave por computador, **a mesma** para todos os agentes e contas da máquina (a chave identifica a máquina+pessoa).
6. **Instruções/skills do agente:** `ai-memory install-instructions` (bloco de roteamento em `CLAUDE.md`/`AGENTS.md`), para o agente usar `memory_*` direito. Pergunta 8.
7. **Registrar o MCP da ufba.app** em cada agente: Claude Code `claude mcp add --transport http --scope user ufba https://api.ufba.app/mcp` (por `CLAUDE_CONFIG_DIR`); demais agentes via adaptador próprio (a confirmar por agente na etapa 0). **Não** executar `install-mcp` do ai-memory (decisão 1). A autenticação OAuth do MCP acontece depois, quando a pessoa abre o `/mcp` no agente.
8. **Auto-teste:** `ai-memory status` e `GET {memory}/identity` com a chave (devolve `operator`; confirma que a chave resolve para a pessoa certa), sem escrever nada. Resumo final em pt-BR do que foi feito e como desfazer (`ai-memory uninstall --only hooks --apply`).
9. **Atualizar/consertar:** rodar de novo repete tudo. Se `~/.ufba/computer.json` tem `computer_id` válido, o passo 3 usa **rotação** (`rotate`) em vez de criar outra chave; se o login de dispositivo for pulado (sem rede), nada muda.

Desinstalar: `ufba-memory uninstall` (ou o comando oficial) revoga a chave no servidor com o token do passo 3 (precisa de novo login) ou, sem rede, só remove localmente e a pessoa revoga no painel.

## 10. O que a API faz e o que o web faz

**API (este repo, Alicerce):** `MemoryAdminClient` (HTTP para `/admin/*`, `Secret`, timeouts, erros sem corpo); `MemoryUsers`, `MemoryComputers`, `DeviceAuthorizations`, `MemoryGroups`, `GrantReconciler`; OAuth device grant; proxy MCP com filtro e cache; ferramentas/prompt/instructions; migração; testes (contrato, arquitetura, canário, fake do ai-memory (servidor `http` de teste) que imita `/admin/*` e `/mcp`); documentação (`docs/MEMORIA.md`, `docs/MCP.md`); regeneração do `openapi.json`.

**Web (Mosaico):** página `/device` (login, código, confirmação com contexto, resultado); "Memória > Computadores conectados" (lista, renomear, revogar, botão "conectar novo computador" com os comandos por SO, estado "sem computadores"); depois "Memória > Grupos e projetos". A API entrega o contrato primeiro (`openapi.json`), o web adapta o contrato dele à mão como hoje.

**Fora do escopo:** captura/limpeza de transcrição (é do ai-memory na máquina), tradução de hooks, qualquer IA no servidor da ufba.app. **No servidor do ai-memory**, confirmar que não há provedor de LLM nem embeddings externos configurados (consolidação por LLM do ai-memory seria "IA no servidor"); pergunta 3.

## 11. Riscos e pontos de atenção

- **Root do memory na API.** Quem comprometer o serviço `api` ganha `/admin/*` do memory (ler tudo, criar chaves). Mitigar: token só neste serviço; módulo único que o usa; sem rota que repasse caminho `/admin` arbitrário; permissões do Railway só leitura; rotação do token documentada (o memory aceita uma troca de `AI_MEMORY_AUTH_TOKEN` sem invalidar chaves `aim_`, a confirmar em S6).
- **Pepper do memory** não pode girar (invalida todas as chaves). Entra no runbook.
- **Conteúdo capturado.** Hooks enviam resumo/transcrição da sessão. Pode conter dado sensível. Depende da limpeza local do `[capture]` e de o projeto-alvo ser o certo (marcador `.ai-memory.toml`). Sem marcador, o ai-memory decide o escopo padrão (pergunta 9).
- **Acesso a todo o projeto.** Em grupos de alunos, membro lê **todas** as páginas do projeto (sem RBAC por página). Dizer isso na tela de grupos.
- **Dependência do memory.** Se cair, as ferramentas da casa continuam; as `memory_*` somem e `memory_status` explica. Hooks locais seguram em fila.
- **Atualizações do ai-memory.** Fixar a versão; atualizar é uma etapa deliberada (nova lista de ferramentas classificada, teste contra a nova versão).
- **Privacidade de nomes/e-mails** de alunos no memory (autoria de páginas).

## 12. Ordem de entrega (etapas pequenas, cada uma com PR próprio)

| Etapa | Entrega | Quem |
|---|---|---|
| **0. Spike** (sem produção, `ai-memory` local descartável com `AI_MEMORY_AUTH_TOKEN` e `token_pepper` de teste) | Confirmar: S1 `install-hooks` só com variáveis, sem `init`/`setup`, em máquina limpa; S2 usuário humano com senha descartada ou `disable` e a chave `aim_` continua valendo; S3 limite de chaves na rota de admin; S4 `GET /admin/api-credentials` traz `last_used_at` atualizado por hook; S5 `tools/list` real e classificação; S6 troca do token root sem invalidar chaves; S7 `/identity`. Resultado em nota anexa a este documento. | API |
| **1. Núcleo memory** | `MemoryAdminClient`, `MemoryUser` ensure, migração, fake do ai-memory, canário | API |
| **2. Proxy MCP** | `tools/list`/`tools/call` filtrados, `memory_status`, limites, `instructions` | API |
| **3. Login de dispositivo** | grant no `/token`, `/oauth/device_authorization`, `DeviceAuthorization`, `POST /memory/computers`, manifesto | API |
| **4. Telas** | `/device`, Computadores conectados | Mosaico (contrato desta API) |
| **5. Instalador** | repo `ufba-app/memory`: bootstrap, Windows + Linux/macOS, CI | API + review do André |
| **6. Ensino do agente** | `memory_connect_computer`, prompt `conectar computador`, textos | API |
| **7. Grupos e grants** | tabelas, reconciliador, rotas web, telas | API + Mosaico |
| **8. Endurecimento** | assinatura minisign, rotação de chaves de repasse, alertas de limite, runbook | API |

Cada etapa só vai para produção depois de CI verde. Nenhum teste contra SIGAA/AVA reais (esta feature não toca nas fontes).

## 13. Perguntas para o André

1. **Chave de repasse na API.** Aceita guardar uma chave `aim_` de repasse **por pessoa**, cifrada com `SECRETS_KEY`? É a única forma de o grant do memory valer (o proxy por cabeçalho ignora grants). A alternativa seria o MCP da ufba.app não repassar nada e cada pessoa registrar o MCP do memory, o que contradiz a decisão 1.
2. **Token root do ai-memory no Railway** como segredo do serviço `api`. OK? Quem cuida da rotação?
3. **IA no servidor do memory.** Posso assumir que o ai-memory em `memory.ufba.app` roda **sem** provedor de LLM nem embeddings externos? Se tiver consolidação por LLM ligada, isso fere a regra.
4. **Teto de computadores** por pessoa: 10 ativos está bom?
5. **Nome e e-mail no memory.** Mandar nome e e-mail @ufba.br para o ai-memory (aparece como autor das páginas, útil em grupo) ou só um apelido (`u<hex>`) até a pessoa escolher?
6. **Usuário "humano" sem login.** O memory só cria usuário como "humano" (senha temporária que descartamos). Pode ser que a pessoa, no futuro, queira entrar no console web do memory; aceita que isso fique **desligado** por enquanto (a senha é descartada)?
7. **Ao excluir a conta (`DELETE /me`)**, as páginas que a pessoa escreveu continuam no memory (autoria preservada) ou devem ser apagadas? O desenho atual mantém.
8. **Instruções do agente.** Instalar o bloco de roteamento (`install-instructions`, grava `CLAUDE.md`/`AGENTS.md` do usuário) e as Agent Skills do ai-memory na máquina, ou deixar só o `instructions` do MCP? Instalar mexe em arquivos do usuário (com backup), mas melhora muito o uso.
9. **Sem `.ai-memory.toml`.** Se a pasta não tem o marcador, qual projeto recebe a captura? Proponho **não capturar** (ou ir para um projeto pessoal restrito `pessoal-<hex>`) em vez de cair num projeto compartilhado.
10. **Windows e o Maestri.** Onde ficam os `CLAUDE_CONFIG_DIR` por conta do Maestri? Preciso de uma lista fechada de locais (a pasta `~/.maestri-local/accounts/<id>` aparece nas notas deste agente). Pode confirmar, ou pergunto ao Mosaico/Maestri?
11. **Quem pode criar grupo/projeto de trabalho**: qualquer aluno ou só convidados (início só do time de dev)?
12. **Assinatura dos releases (minisign)** desde a primeira versão ou na etapa 8?
13. **Versão fixa do ai-memory:** 3.4.6 fixa e atualização só por decisão sua, ou acompanhar a última estável?
