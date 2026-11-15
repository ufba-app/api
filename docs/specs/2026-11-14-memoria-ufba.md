# Memória compartilhada na ufba.app (desenho)

Status: **proposta para aprovação do André** (revisão 2, com as decisões de 14/11). Sem código. Autor: agente da API (Alicerce), 14/11/2026.
Base: ai-memory **v3.4.6** (`github.com/akitaonrails/ai-memory`, tag `v3.4.6`), lido em `docs/users.md`, `docs/self-service-keys.md`, `docs/install.md`, `docs/frontend-api.md`, `docs/design-per-project-authz.md`, `docs/marker-file.md`, `install.ps1` e o código do CLI (`crates/ai-memory-cli/src/commands/{api_key,user,grant,project}.rs`, `cli.rs`).

## 1. Objetivo e decisões já tomadas

Deixar a memória compartilhada (https://memory.ufba.app) acessível pela ufba.app, para o time de dev e, depois, para grupos de trabalho de alunos. **Sem IA no servidor, nunca.**

Decisões do André (não reabertas aqui):

1. Um MCP só para memória: o da ufba.app (`https://api.ufba.app/mcp`, OAuth com Google @ufba.br). Ele repassa as ferramentas do ai-memory com a credencial da pessoa e pode bloquear as destrutivas. Ninguém registra o MCP do ai-memory. Workspace e projeto vão explícitos em cada chamada.
2. Cada pessoa = um usuário no ai-memory, criado pela API na primeira vez, pela API administrativa do ai-memory (token root só no servidor, como `Secret`). Permissões por projeto, convites e papéis do time ficam na ufba.app, que chama grant/revoke. Projetos nascem restritos (`AI_MEMORY_AUTH__NEW_PROJECTS_RESTRICTED=true`, já ligado).
3. Captura por hooks continua sendo do ai-memory oficial na máquina (fila offline, limpeza local, `[capture]` do `.ai-memory.toml`). Sem tradutor de hooks na API.
4. Um comando genérico de instalação (`irm https://ufba.app/install.ps1 | iex` e `curl -fsSL https://ufba.app/install.sh | sh`), com login de dispositivo (RFC 8628), uma chave por computador gravada direto na config do ai-memory, detecção de agentes, hooks e registro do MCP. Idempotente. Scripts abertos em `ufba-app/memory`, servidos pela ufba.app.
5. Painel: "Memória > Computadores conectados" e a página `/device` (Mosaico).
6. O MCP ensina o agente: `instructions`, `memory_connect_computer`, `memory_status` e um prompt `conectar computador`.

### 1.1 Decisões de 14/11 (André, via orquestrador)

| | Decisão |
|---|---|
| a | Chave de repasse por pessoa, cifrada com `SECRETS_KEY` na API (como os tokens do Moodle/Google). |
| b | Token root do memory é segredo do serviço `api` no Railway (mesmo valor do `AI_MEMORY_AUTH_TOKEN` do serviço memory). **Quem gira é o André**; procedimento em §8.6. |
| c | O memory roda **sem LLM e sem chave externa**. Há um embedder **local** no container (`embedder enabled provider=local model=all-MiniLM-L6-v2 dim=384`, sem chave nem chamada externa). **Decisão: manter.** Registrado em §3.1. |
| d | Usuário no memory com `username` anônimo `u<hex>` e **nome de exibição = nome do Google** (colegas precisam ver quem escreveu). Sem e-mail no memory. |
| e | Repositório sem `.ai-memory.toml`: **não captura** (modo allowlist). Detalhe e limite em §2 e §9. |
| f | Não instalar skills nem instruções na máquina por enquanto; as `instructions` do MCP bastam. |
| g | Configs por conta do Maestri: `C:\Users\<usuario>\.maestri-local\accounts\<id>`, cada uma é um `CLAUDE_CONFIG_DIR`. O instalador detecta e **oferece** instalar em cada. |
| h | `DELETE /me`: apaga os projetos pessoais (a pessoa é dona e única); em projetos compartilhados o conteúdo fica com o projeto, **desvinculando o nome** (§4.4). |
| i | Qualquer pessoa logada cria projeto (vira dono); o dono convida pelo e-mail @ufba.br. |
| j | Versão fixa 3.4.6; atualizar é deliberado, pelo `VERSION` do repo `ufba-app/memory`. |

Acréscimos (orquestrador): (1) **não conflitar** com um ai-memory já instalado (o André usa outro servidor, o grimório): perfil de servidor nomeado `ufba`, instalador nunca sobrescreve servidor/chave padrão; (2) painel em duas partes, **Meus projetos** (todos) e **Administração** (papel admin); (3) **papéis do time** como atalho de permissões, numa tabela de configuração da API.

As demais perguntas do rascunho anterior foram resolvidas seguindo a recomendação do autor e estão marcadas **"decidido pelo orquestrador, revisar com o André"** em §13.

## 2. O que a documentação oficial confirma (e o que não)

| Pergunta | Resposta verificada na v3.4.6 | Impacto |
|---|---|---|
| Root cria usuário por API? | **Sim.** `POST /admin/human-users` `{username, name?, email?, role?}` (usado por `ai-memory user add-human`) devolve o usuário e uma **senha temporária** (`temporary_password`). Autenticação: bearer root (`AI_MEMORY_AUTH_TOKEN`). Não existe mais criação de usuário "só com chave" (o `user add` 1.x foi removido na 3.0). | A API cria o usuário como "humano" e **descarta a senha temporária** sem gravar nem logar. Ninguém entra no console web do memory por senha. Ver §13.2 e o ponto de spike S2. |
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
| Perfis de servidor (`ai-memory server add`) | **Sim** (`docs/marker-file.md`, "Routing capture to another server"). `ai-memory server add <nome> --url <url> --root <pasta> --auth-token-stdin`; marcador do repositório com `server = "<nome>"` (nome de perfil, nunca URL). Perfis em `<data_dir>/servers.toml`, token em `<data_dir>/auth-tokens/<nome>` (só do dono). Com mais de um perfil, `--root` é obrigatório e marcador fora dos roots não escolhe o perfil. Falha fechada: perfil inválido = o hook não emite nada, nunca cai no servidor padrão. | O instalador usa perfil `ufba` quando já existe ai-memory (§9.1). A chave entra por **stdin**, nem argumento nem ambiente. |
| Limites dos perfis | **Só hooks nativos** roteiam perfil; integrações TypeScript (`opencode`, `opencode2`, `omp`, `pi`, `openclaw`) e scripts `.sh`/`.ps1` não roteiam (num repositório com `server` não emitem nada). Cliente mais antigo que o suporte **ignora** `server` e entrega ao servidor padrão. | Em `profile`, só agentes com hook nativo; parar se a versão instalada for menor que 3.4.6. |
| Modo allowlist | `ai-memory install-hooks --apply --capture-mode allowlist`: sem `.ai-memory.toml` o repositório não emite **nenhum** evento. É **por instalação**, não por agente; um `install-hooks --apply` posterior mantém o modo. | `fresh`: ligamos. `profile`: **não** alteramos (mudaria o comportamento do servidor padrão da pessoa). |
| Instalar o binário | `install.ps1`/`install.sh` oficiais aceitam `AI_MEMORY_VERSION=3.4.6`, verificam `.sha256` (do mesmo origin da zip) e **recusam um destino já existente**. | O nosso instalador checa `ai-memory --version` antes: se já é 3.4.6, não reinstala; se é outra, usa `ai-memory upgrade`/reinstalação controlada. Fixamos o SHA-256 do artefato dentro do instalador (ver §8). |
| Atribuição | `pages.author_id` e o audit log carregam o usuário; páginas são compartilhadas **dentro** do projeto (sem RBAC por página); handoffs e sessões têm dono. | Quem está no projeto lê tudo do projeto. Sinalizar na tela de Meus projetos. |

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
        ▲ instalador                │  Postgres: projetos, computadores │ (só a  └───────────────────────┘
        │ (irm | iex)               └────────────────────────────────┘  API)
        └──── ufba.app/device (Mosaico) ◀── aprovação com sessão do Google
```

Duas credenciais **diferentes** por pessoa no ai-memory, de propósito:

- **Chave de computador** (`label` `pc:…`): uma por máquina, mostrada uma vez ao instalador, gravada pelo próprio ai-memory na máquina. **A API não a guarda** (só `credentialId`, prévia e metadados). Usada só por hooks, direto no `memory.ufba.app`. Revogar um computador revoga só ela.
- **Chave de repasse** (`label` `ufba-proxy`): uma por pessoa, criada junto com o usuário, **guardada cifrada na API** (`SECRETS_KEY`, como os tokens do Moodle/Google). Usada só pelo proxy do MCP em nome da pessoa. Não passa pelo token OAuth do cliente (diferente da senha do SIGAA, aqui não há razão para a chave K: o conteúdo é memória de trabalho, não credencial da UFBA, e o servidor precisa chamar sem a pessoa presente para grants/status).

Por que uma de repasse separada: o proxy precisa de uma credencial que a API possa usar a qualquer momento, e a chave de computador, por desenho, nunca fica na API. Se a de repasse vazar do banco, ela só vale com a `SECRETS_KEY` e nunca é admin; rotação por pessoa é uma chamada (`rotate`).


### 3.1 Sem IA no servidor (embedder local)

O memory roda **sem LLM e sem chave externa**. O log do serviço mostra `embedder enabled provider=local model=all-MiniLM-L6-v2 dim=384`: modelo de embeddings **local**, dentro do container, sem chamada externa nem chave. **Decisão do André: manter.** Ele não gera texto nem decide nada; só vetoriza para busca. A ufba.app não adiciona nenhuma IA própria. Continua valendo checar, a cada mudança de versão ou de configuração do memory, que nenhum provedor de LLM nem de embeddings externo foi ligado.
**O que o servidor ai-memory nunca recebe da ufba.app:** senha do SIGAA, tokens de Moodle/Google, nada das fontes. Memória é o que o agente da pessoa escreve.

## 4. Fluxos

### 4.1 Primeiro uso (a pessoa nunca viu o memory)

1. A pessoa autentica o Claude (ou outro cliente MCP) na ufba.app pelo OAuth que já existe.
2. Primeira chamada a qualquer ferramenta `memory_*` (ou `memory_status`): `MemoryUsers.ensure(userId)`:
   - lê `memory_users`; se não existe: `POST /admin/human-users` com `username = u<12 hex do userId>` (estável, sem PII), `name` = nome do Google (decisão d; sem `email`); **descarta `temporary_password`**;
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
3. `tools/call` de `memory_*`: a API valida o nome contra a lista permitida, repassa **o corpo sem alteração** com a chave de repasse e devolve a resposta. Workspace e projeto explícitos: a API **não** deduz escopo (o `/mcp` da casa é sem sessão, e o auto-scope do ai-memory depende de sessão/hook). Erro 403 do memory vira erro MCP legível ("sem acesso ao projeto X; peça ao dono do projeto").
4. Nada do conteúdo da chamada vai para log. Só: usuário (id), nome da ferramenta, workspace/projeto, status, latência.

### 4.4 Revogação

- **Um computador:** `DELETE /web/memory/computers/{id}` → `POST /admin/api-credentials/{credentialId}/revoke` → marca `revoked_at`. Hooks desse computador passam a receber 401 e **param de capturar** (a fila local envelhece sem travar; doc #493). Os outros computadores e o MCP seguem.
- **Pessoa inteira** (`DELETE /me` já existente), nesta ordem: (1) revoga todas as chaves (`pc:` e `ufba-proxy`); (2) **projetos pessoais** (a pessoa é dona e única membro): apaga o projeto no memory e na ufba.app; (3) **projetos compartilhados**: o conteúdo **fica com o projeto**; a posse passa ao membro `write` mais antigo (sem membro, é tratado como pessoal e apagado); (4) remove convites e grants; (5) `POST /admin/users/{username}/disable` e **desvincula o nome** (nome de exibição vira "Ex-participante" via `PATCH /admin/users/{username}`); `username` já é anônimo (`u<hex>`) e `author_id` continua resolvendo. A rota exata de apagar projeto e o `PATCH` ficam para o spike S11.
- **Sair/remover de projeto:** §4.5. Sempre `revoke` explícito; a chave de computador não muda (o acesso é do usuário, não da chave).

### 4.5 Projetos, convites e papéis do time

Fonte da verdade na ufba.app (estado desejado); o ai-memory só reflete via grant/revoke. A ufba.app é a **única** que chama `/admin/users/*/grant|revoke` e `/admin/projects/access`.

**Meus projetos (qualquer pessoa logada).**
- **Criar:** a API cria o projeto no memory já `restricted` (`POST /admin/projects/access {mode:"restricted"}` como cinto e suspensório do `NEW_PROJECTS_RESTRICTED`), grava `memory_projects` com `owner_id` = a pessoa e concede `write` a ela. Naming proposto: workspace `ufba-alunos`, projeto `<slug>-<4 hex>` (único, estável); o time usa o workspace `ufba-app` (§5). Decidido pelo orquestrador, revisar com o André.
- **Convidar:** o dono informa um e-mail `@ufba.br` e o nível (`read` ou `write`). Só quem já tem conta na ufba.app; se não tem, o convite fica `pending` e vale no primeiro login (a API só chama grant quando a pessoa existe no memory).
- **Mudar permissão / remover / sair:** o dono muda ou remove; o membro pode **sair** (revoga o próprio acesso). Só o dono gerencia. Dono não sai sem transferir (§4.4).
- **Nível efetivo** de uma pessoa num projeto = o **maior** entre o convite direto e o que vier de papéis do time.

**Papéis do time (atalho de permissões).** Tabela de configuração da API, **não por pessoa**:

| Papel | `ufba-app/api` | `ufba-app/web` | `ufba-app/docs` |
|---|---|---|---|
| `dev` | write | write | read |
| `maintainer` | write | write | write |

- Atribuir papel concede; retirar revoga (só o que mais nenhum convite/papel sustenta). Projeto novo do time entra na tabela (`TeamRoleGrant`) e **vale para todos com o papel** na próxima reconciliação.
- `write` em `docs` = poder de publicar no `docs.ufba.app` (tag `public`); por isso só `maintainer`.
- Quem atribui papéis: o **admin** (papel de aplicação, o André) na tela **Administração**. Admin inicial vem de configuração do serviço (e-mail do André), não de tabela editável por outros.

**Reconciliação** (idempotente; roda ao mudar convite/papel/tabela e por varredura de 10 min): por pessoa, calcula os níveis efetivos, compara com `GET /admin/users/{username}/grants` e emite só o que diverge. Falhas ficam em `memory_sync_jobs` (retentativa com backoff); a tela mostra "sincronizando". Quem ainda não tem usuário no memory é criado antes (`ensure`).

**Ressalvas do ai-memory** (mostrar na tela): quem tem acesso lê **todas** as páginas do projeto (sem RBAC por página); handoffs são do dono da sessão; o memory não tem "administrador de projeto", então a administração é sempre da API.

## 5. Modelo de dados novo (Postgres/Prisma)

Pasta nova `prisma/models/memory/`. Identificadores em inglês.

```prisma
model MemoryUser {
  userId            String   @id @map("user_id") @db.Uuid
  memoryUsername    String   @unique @map("memory_username")   // u<12 hex>, sem PII
  status            String                                       // creating | ready | disabled
  proxyCredentialId String?  @map("proxy_credential_id")        // id no ai-memory
  proxyKeyEnc       Bytes?   @map("proxy_key_enc")              // cifrada com SECRETS_KEY
  displayName       String?  @map("display_name")               // nome do Google enviado ao memory
  createdAt         DateTime @default(now()) @map("created_at")
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  computers         MemoryComputer[]
  @@map("memory_users")
}

model MemoryComputer {
  id            String    @id @default(uuid(7)) @db.Uuid
  userId        String    @map("user_id") @db.Uuid
  name          String                                          // editável
  os            String                                          // windows | macos | linux
  credentialId  String    @map("credential_id")                 // id no ai-memory (NUNCA a chave)
  keyPreview    String?   @map("key_preview")
  agents        String[]                                        // detectados no último install
  clientVersion String?   @map("client_version")
  installMode   String?   @map("install_mode")                  // fresh | profile (§9)
  createdAt     DateTime  @default(now()) @map("created_at")
  lastSeenAt    DateTime? @map("last_seen_at")                  // last_used_at do memory
  revokedAt     DateTime? @map("revoked_at")
  user          MemoryUser @relation(fields: [userId], references: [userId], onDelete: Cascade)
  @@index([userId, revokedAt])
  @@map("memory_computers")
}

model DeviceAuthorization {                                     // RFC 8628; tudo curto (10 min)
  deviceCodeHash String    @id @map("device_code_hash")         // SHA-256
  userCodeHash   String    @unique @map("user_code_hash")
  clientId       String    @map("client_id")
  scope          String
  computerName   String?   @map("computer_name")                // sugestão do instalador (não confiável)
  os             String?
  requestIp      String?   @map("request_ip")
  status         String                                         // pending | approved | denied | consumed
  userId         String?   @map("user_id") @db.Uuid
  intervalSec    Int       @default(5) @map("interval_sec")
  lastPolledAt   DateTime? @map("last_polled_at")
  failedLookups  Int       @default(0) @map("failed_lookups")
  expiresAt      DateTime  @map("expires_at")
  @@index([expiresAt])
  @@map("device_authorizations")
}

model MemoryProject {
  id        String   @id @default(uuid(7)) @db.Uuid
  workspace String
  project   String
  kind      String                                              // personal | shared | team
  ownerId   String?  @map("owner_id") @db.Uuid                  // null só em projeto do time
  createdAt DateTime @default(now()) @map("created_at")
  members   MemoryProjectMember[]
  teamGrants TeamRoleGrant[]
  @@unique([workspace, project])
  @@map("memory_projects")
}

model MemoryProjectMember {                                     // convite direto (Meus projetos)
  projectId String   @map("project_id") @db.Uuid
  userId    String?  @map("user_id") @db.Uuid                   // null enquanto o convite está pendente
  email     String                                              // @ufba.br, normalizado
  level     String                                              // read | write
  status    String                                              // pending | active
  invitedBy String   @map("invited_by") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  project   MemoryProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@id([projectId, email])
  @@map("memory_project_members")
}

// Tabela de CONFIGURAÇÃO (semeada por migração; mudar papel = migração/PR, não tela por pessoa).
model TeamRole {
  key         String @id                                        // dev | maintainer
  description String
  grants      TeamRoleGrant[]
  assignments UserTeamRole[]
  @@map("team_roles")
}

model TeamRoleGrant {                                           // papel -> projeto -> nível
  roleKey   String @map("role_key")
  projectId String @map("project_id") @db.Uuid
  level     String                                              // read | write
  role      TeamRole      @relation(fields: [roleKey], references: [key], onDelete: Cascade)
  project   MemoryProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  @@id([roleKey, projectId])
  @@map("team_role_grants")
}

model UserTeamRole {                                            // atribuição por pessoa (Administração)
  userId     String   @map("user_id") @db.Uuid
  roleKey    String   @map("role_key")
  assignedBy String   @map("assigned_by") @db.Uuid
  assignedAt DateTime @default(now()) @map("assigned_at")
  role       TeamRole @relation(fields: [roleKey], references: [key], onDelete: Cascade)
  @@id([userId, roleKey])
  @@map("user_team_roles")
}

model MemorySyncJob {                                           // fila de reconciliação com o memory
  id        String   @id @default(uuid(7)) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  attempts  Int      @default(0)
  nextRunAt DateTime @map("next_run_at")
  lastError String?  @map("last_error")                         // só código/status, nunca corpo
  @@index([nextRunAt])
  @@map("memory_sync_jobs")
}
```

Notas:
- **Papel de aplicação `admin`** não é tabela: é a lista de e-mails de administradores da configuração do serviço (variável `MEMORY_ADMIN_EMAILS`, só nomes de variável aqui). Evita que alguém se promova.
- `TeamRole`/`TeamRoleGrant` são semeadas na migração com `dev` e `maintainer` (tabela de §4.5) e com os projetos `ufba-app/{api,web,docs}` marcados `kind=team`. Projeto novo do time = nova linha em `TeamRoleGrant` (migração) e a reconciliação concede a todos os com o papel.
- `DeviceAuthorization` e tokens curtos são limpos por varredura (`expiresAt`). `DELETE /me` apaga em cascata depois de revogar no memory (§4.4). Migração entra no `prisma migrate deploy` do Dockerfile.

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

**Dispositivo e computadores** (Mosaico: `/device` e Memória > Computadores conectados)

| Rota | Descrição |
|---|---|
| `POST /web/device/lookup` | `{user_code}` → `{client_name, computer_name, os, requested_at, approx_location}`; conta tentativa errada (§8.2). |
| `POST /web/device/decision` | `{user_code, decision: "approve"\|"deny"}`. |
| `GET /web/memory/status` | `{memory_available, user_ready, is_admin, computers:[…], projects:[…]}`. |
| `GET /web/memory/computers` | `[{id,name,os,agents,install_mode,created_at,last_seen_at,revoked_at}]`. |
| `PATCH /web/memory/computers/{id}` | `{name}`. |
| `DELETE /web/memory/computers/{id}` | Revoga (§4.4). Sem corpo. |

**Meus projetos** (qualquer pessoa logada; só o dono altera)

| Rota | Descrição |
|---|---|
| `GET /web/memory/projects` | Projetos em que a pessoa participa: `[{id, workspace, project, kind, role: "owner"\|"read"\|"write", source: "owner"\|"invite"\|"team", members_count, sync: "ok"\|"pending"}]`. |
| `POST /web/memory/projects` | `{name}` → projeto novo; a pessoa vira dono (`write`). 409 `project_name_taken`. |
| `GET /web/memory/projects/{id}` | Detalhe com membros e convites (`[{email, name?, level, status}]`) e o trecho do marcador `.ai-memory.toml` para colar no repositório (§9). |
| `PUT /web/memory/projects/{id}/members/{email}` | `{level: "read"\|"write"}`: convida ou muda permissão. Só e-mail `@ufba.br` (400 `invalid_email_domain`). Só dono. |
| `DELETE /web/memory/projects/{id}/members/{email}` | Remove um membro (dono) ou **sai** (o próprio e-mail). |
| `POST /web/memory/projects/{id}/transfer` | `{email}`: passa a posse a um membro com `write`. |
| `DELETE /web/memory/projects/{id}` | Dono apaga o projeto (confirmação no web). |

**Administração** (só papel `admin`; 403 `not_admin` para os demais)

| Rota | Descrição |
|---|---|
| `GET /web/admin/team` | `{roles:[{key, description, grants:[{project, level}]}], members:[{userId, name, email, roles:[…]}]}`. |
| `PUT /web/admin/team/members/{userId}/roles/{roleKey}` | Atribui papel (concede). |
| `DELETE /web/admin/team/members/{userId}/roles/{roleKey}` | Retira papel (revoga o que ficar sem sustentação). |
| `GET /web/admin/memory/sync` | Fila de reconciliação com falhas (códigos, sem corpo). |

A tabela de papéis é **somente leitura** na API/tela (mudar é migração, para a escrita em `docs` exigir revisão).

Novos códigos em `API_ERROR_CODES`: `device_code_invalid`, `device_code_expired`, `computer_limit_reached`, `memory_unavailable`, `memory_forbidden`, `project_not_found`, `project_name_taken`, `not_project_owner`, `invalid_email_domain`, `not_admin`, `role_not_found`. Textos (`message`) em pt-BR; identificadores em inglês.

## 7. MCP: ferramentas, `instructions` e filtro

### 7.1 `instructions` do servidor (no `initialize`)

Texto proposto (pt-BR; entra em `instructions`, curto):

> "Este servidor também dá acesso à memória compartilhada da equipe (ferramentas `memory_*`). Sempre informe `workspace` e `project` explicitamente. A memória guarda o que você escreve; nunca grave senhas, tokens ou dados pessoais de outras pessoas. Existe captura automática das sessões quando o computador da pessoa está conectado e o repositório tem um `.ai-memory.toml` (sem ele, nada é capturado). Chame `memory_status` no começo de uma conversa em que a memória seja relevante. Se não houver computador conectado e a pessoa quiser captura automática, ofereça `memory_connect_computer`. Nunca execute comandos de instalação sem pedir permissão antes."

### 7.2 Ferramentas

| Ferramenta | Comportamento |
|---|---|
| `memory_status` | Sem parâmetros. Lê **do servidor** (nunca confia no agente): `{memory_available, user_ready, connected_computers:[{name, os, last_seen}], hint}`. `last_seen` vem de `last_used_at` do memory (a chamada `GET /admin/api-credentials` filtrada pelo usuário). Quando não há computador: `hint` "Nenhum computador conectado. Ofereça `memory_connect_computer`". |
| `memory_connect_computer` | Parâmetro `os` opcional (`windows`\|`macos`\|`linux`). Devolve o passo a passo **como texto**: o comando de uma linha do sistema, o que ele faz (lista curta e honesta: instala o ai-memory v3.4.6, abre o navegador para aprovar, grava a chave, instala hooks, registra este MCP), o aviso "peça permissão à pessoa **antes** de rodar" e a alternativa "se este cliente não tem terminal, mostre o comando para a pessoa colar". Também devolve o link `<WEB_ORIGIN>/memory/computers`. **Não executa nada e não devolve segredo.** |
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
| Chave de computador (`aim_`) | **Só na máquina**: `<data_dir>/auth-token` e `auth-header` (modo `fresh`) ou `<data_dir>/auth-tokens/ufba` (perfil `ufba`), `0600`, pasta `0700` (o ai-memory grava) | A API só tem `credentialId` e a prévia. Mostrada uma vez ao instalador (HTTPS, `no-store`). Nunca em log do instalador. |
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

### 8.6 Girar o token root do memory (procedimento do André)

O valor é o mesmo nos dois serviços do Railway: `AI_MEMORY_AUTH_TOKEN` (serviço memory) e `MEMORY_ROOT_TOKEN` (serviço api). Agentes não leem nem imprimem esse valor; o Railway fica só leitura para eles.

1. Gerar um valor novo na máquina do André: `ai-memory generate-auth-token` (sai no terminal; não colar em chat, arquivo ou commit).
2. No Railway, trocar `AI_MEMORY_AUTH_TOKEN` no serviço **memory** e `MEMORY_ROOT_TOKEN` no serviço **api**. Para nunca copiar o valor duas vezes, preferir **variável de referência** do Railway no serviço api apontando para a do memory (confirmar o recurso no painel).
3. Reimplantar **memory** e depois **api**. Janela curta em que o proxy responde `memory_unavailable`; as ferramentas da casa seguem.
4. Verificar: `memory_status` pelo MCP responde `memory_available: true`, e um computador conectado continua capturando (as chaves `aim_` não dependem do root bearer; **confirmar no spike S6**).
5. **Nunca** girar o `token_pepper` do memory: invalida todas as chaves `aim_` (computadores e repasse).
6. Se o token vazar: girar na hora (passos 1 a 4) e olhar o audit log do memory (`grant_access`/`revoke_access`, criação de chaves) no período.

A chave de repasse de **uma** pessoa gira sem tocar no root: a API chama `rotate` e regrava cifrada.

## 9. O instalador (repo `ufba-app/memory`)

Entregáveis do repo: `install.ps1`, `install.sh` (bootstrap), `installer/` (PowerShell e POSIX sh, sem dependências), manifesto gerado por CI (com `VERSION` do ai-memory e os SHA-256), testes em runners Windows/Linux/macOS, README com a lista do que muda na máquina. Licença AGPL-3.0. Atualizar o ai-memory = mudar o `VERSION` do repo (decisão j).

### 9.1 Dois modos: o instalador nunca sobrescreve o servidor padrão da pessoa

O André já usa um ai-memory com outro servidor (grimório); qualquer pessoa pode ter o mesmo. O instalador **detecta** instalação existente (binário `ai-memory` no PATH, `<data_dir>/config.toml`, `servers.toml` ou hooks do ai-memory nas configs dos agentes) e escolhe:

| Modo | Quando | O que faz |
|---|---|---|
| `fresh` | Nenhum ai-memory na máquina | Instala a versão fixa; hooks com a ufba como servidor padrão e `--capture-mode allowlist`. |
| `profile` | Já existe ai-memory | **Não toca** no servidor/chave padrão nem no modo de captura. Registra o **perfil nomeado `ufba`** e só repositórios cujo marcador diz `server = "ufba"` capturam para a ufba.app. |

**Perfil de servidor, conforme `docs/marker-file.md` (v3.4.6), "Routing capture to another server (`server`)":**

```bash
ai-memory server add ufba --url https://memory.ufba.app --root <pasta> --auth-token-stdin   # a chave entra por STDIN
ai-memory server list      # nomes, URLs, roots e se há token; nunca o token
```
```toml
# .ai-memory.toml na raiz de cada repositório da ufba.app
workspace = "ufba-app"
project   = "api"
server    = "ufba"        # NOME de perfil, nunca URL
```

- Perfis ficam em `<data_dir>/servers.toml`; o token em `<data_dir>/auth-tokens/ufba`, só do dono. Marcador, config de hook e linha de comando **nunca** têm URL ou token do perfil. A chave entra por `--auth-token-stdin`: não vai em argumento nem em variável de ambiente.
- **`--root`** (pasta(s) onde ficam os repositórios da ufba.app) é **obrigatório quando há mais de um perfil**, e um marcador fora dos roots **não consegue** escolher o perfil (impede um repositório clonado de apontar para o perfil errado). O instalador **pergunta** a pasta (sem varrer o disco). Em `--yes`, exige `--root`.
- **Falha fechada:** perfil desconhecido, sem token, fora dos roots ou `servers.toml` inválido → o hook **não emite nada** (nem fila, nem handoff). Nunca cai no servidor padrão.
- Repositório sem `server` continua indo para o servidor padrão (grimório) **como antes**: a ufba.app não interfere. Repositório sem marcador **nunca** vai para a ufba.app (decisão e); em `fresh` é o modo allowlist que garante isso.
- Comandos do dia a dia (`search`, `read-page`, `write-page`…) seguem a rota do perfil dentro do checkout. `status`, `user`, `api-key` etc. usam o servidor padrão.
- **Limites documentados:** (1) só os **hooks nativos** (`ai-memory hook`) roteiam perfil. As integrações TypeScript (`opencode`, `opencode2`, `omp`, `pi`, `openclaw`) e os scripts `.sh`/`.ps1` **não** roteiam: num repositório com `server`, não emitem nada. Em `profile` o instalador **não** instala esses agentes e avisa. (2) Cliente mais antigo que o suporte a `server` **ignora** a chave e entregaria ao servidor padrão; por isso, em `profile`, o instalador **para** se a versão instalada for menor que a fixa (3.4.6), explica e não altera nada. (3) `--capture-mode` é **por instalação**, então em `profile` não o alteramos.
- Se algo disso não se comportar como a doc diz no spike (S8 a S10, §12), o instalador **para e explica** em `profile`, em vez de arriscar sobrescrever.

### 9.2 Passos (idempotentes, cada um verifica antes de agir)

1. **Pré-checagem:** SO/arquitetura; `api.ufba.app` e `memory.ufba.app` acessíveis; `--dry-run`; detecção do modo (§9.1).
2. **Binário:** `fresh`: instala a versão do manifesto com o SHA-256 do manifesto (o script oficial recusa destino existente, checamos antes). `profile`: confere a versão (para se menor que a fixa).
3. **Login de dispositivo** (§4.2) e `POST /memory/computers` (`install_mode` informado).
4. **Detectar agentes** em lista fechada de locais (nada de varrer disco): `claude` e `~/.claude`; **contas do Maestri**: cada subpasta de `C:\Users\<usuario>\.maestri-local\accounts\` (Windows; equivalente em outros SOs, a confirmar) é um `CLAUDE_CONFIG_DIR`. O instalador **lista e oferece** instalar em cada uma (`--yes` aceita todas); `codex`, `gemini`, `cursor` conforme o spike S8.
5. **Gravar a chave:** `fresh`: `AI_MEMORY_AUTH_TOKEN` só no ambiente do processo filho de `install-hooks --server-url https://memory.ufba.app --capture-mode allowlist --apply`. `profile`: `ai-memory server add ufba … --auth-token-stdin`, depois `install-hooks --agent <x> --apply` **sem** `--server-url`/`--auth-token` (a doc diz que um `install-hooks --apply` simples mantém a configuração existente; confirmar em S9). Por conta do Maestri: repetir com `CLAUDE_CONFIG_DIR=<dir>`. Uma chave por computador, a mesma para todas as contas e agentes.
6. **Não instalar** `install-instructions`, skills nem bloco em `CLAUDE.md`/`AGENTS.md` (decisão f). As `instructions` do MCP bastam.
7. **Registrar o MCP da ufba.app** por conta: `claude mcp add --transport http --scope user ufba https://api.ufba.app/mcp` (por `CLAUDE_CONFIG_DIR`); demais agentes por adaptador próprio (spike). **Nunca** `install-mcp` do ai-memory (decisão 1). O OAuth do MCP acontece depois, no `/mcp` do agente.
8. **Marcador no repositório:** o instalador **não grava** marcadores. A tela do projeto (§6.3) mostra o trecho `.ai-memory.toml` para colar; para repositórios já abertos, `ai-memory project init` interativo é opção da pessoa.
9. **Auto-teste** sem escrever: `ai-memory server list` / `--check-capture` num diretório de exemplo (`server_resolution` esperado `marker`), e `GET {memory}/identity` com a chave (confirma que resolve para a pessoa certa). Resumo final em pt-BR do que mudou e como desfazer.
10. **Atualizar/consertar:** rodar de novo repete tudo. Com `~/.ufba/computer.json` (`computer_id`, sem segredo) o login de dispositivo termina em **rotação** (`rotate`) da mesma chave; `server add` reaproveita os roots quando `--root` é omitido.

Desinstalar: `ufba-memory uninstall` remove só o que a ufba instalou (perfil `ufba`, MCP `ufba`, e hooks **somente** se foi modo `fresh`); em `profile` nunca remove os hooks do servidor padrão da pessoa. Revoga a chave com novo login ou a pessoa revoga no painel.

## 10. O que a API faz e o que o web faz

**API (este repo, Alicerce):** `MemoryAdminClient` (HTTP para `/admin/*`, `Secret`, timeouts, erros sem corpo); `MemoryUsers`, `MemoryComputers`, `DeviceAuthorizations`, `MemoryProjects` (dono, convites, transferência), `TeamRoles`, `GrantReconciler`; OAuth device grant; proxy MCP com filtro e cache; ferramentas/prompt/instructions; migração (inclui semear `team_roles`); testes (contrato, arquitetura, canário, fake do ai-memory em servidor `http` de teste que imita `/admin/*` e `/mcp`); `docs/MEMORIA.md`; regeneração do `openapi.json`.

**Web (Mosaico), três áreas:**
- **`/device`**: login, código, confirmação com contexto, resultado.
- **Memória > Computadores conectados**: lista, renomear, revogar, "conectar novo computador" com os comandos por SO e o aviso do modo `profile`.
- **Memória > Meus projetos** (todo usuário): criar projeto (vira dono), ver o trecho do `.ai-memory.toml`, convidar por e-mail `@ufba.br` com leitura ou escrita, mudar permissão, remover, sair, transferir, apagar; aviso "quem tem acesso lê todas as páginas do projeto"; indicador de sincronização.
- **Administração** (só `admin`): tabela de papéis (somente leitura) e atribuição de `dev`/`maintainer` por pessoa; fila de sincronização com falhas.

A API entrega o contrato primeiro (`openapi.json`); o web adapta o contrato dele à mão como hoje. **Aviso ao Mosaico a cada mudança de contrato.**

**Fora do escopo:** captura/limpeza de transcrição (do ai-memory na máquina), tradução de hooks, qualquer IA no servidor da ufba.app.

## 11. Riscos e pontos de atenção

- **Root do memory na API.** Quem comprometer o serviço `api` ganha `/admin/*` do memory (ler tudo, criar chaves). Mitigar: token só neste serviço; módulo único que o usa; sem rota que repasse caminho `/admin` arbitrário; permissões do Railway só leitura; rotação do token documentada (o memory aceita uma troca de `AI_MEMORY_AUTH_TOKEN` sem invalidar chaves `aim_`, a confirmar em S6).
- **Pepper do memory** não pode girar (invalida todas as chaves). Entra no runbook.
- **Conteúdo capturado.** Hooks enviam resumo/transcrição da sessão. Pode conter dado sensível. Depende da limpeza local do `[capture]` e de o projeto-alvo ser o certo (marcador `.ai-memory.toml`). Sem marcador não captura (decisão e; modo allowlist).
- **Acesso a todo o projeto.** Em projetos compartilhados, membro lê **todas** as páginas do projeto (sem RBAC por página). Dizer isso na tela de Meus projetos.
- **Dependência do memory.** Se cair, as ferramentas da casa continuam; as `memory_*` somem e `memory_status` explica. Hooks locais seguram em fila.
- **Atualizações do ai-memory.** Fixar a versão; atualizar é uma etapa deliberada (nova lista de ferramentas classificada, teste contra a nova versão).
- **Privacidade de nomes/e-mails** de alunos no memory (autoria de páginas).

## 12. Ordem de entrega (etapas pequenas, cada uma com PR próprio)

| Etapa | Entrega | Quem |
|---|---|---|
| **0. Spike** (ai-memory local descartável, `AI_MEMORY_AUTH_TOKEN` e `token_pepper` de teste; nada de produção nem fontes reais) | **S1** `install-hooks` só com variáveis, sem `init`/`setup`, em máquina limpa; **S2** usuário "humano" com senha descartada (ou `disable`) e a chave `aim_` continua valendo; **S3** limite de chaves na rota de admin; **S4** `GET /admin/api-credentials` traz `last_used_at` atualizado por hook; **S5** `tools/list` real e classificação; **S6** troca do token root sem invalidar chaves `aim_`; **S7** `/identity`; **S8** perfis: `server add ufba … --auth-token-stdin`, `--root` com mais de um perfil, `--check-capture` com `server_resolution: marker`, **quais agentes usam hook nativo** (roteiam perfil); **S9** `install-hooks --apply` simples numa instalação existente **não muda** servidor padrão, token nem `--capture-mode`; **S10** detecção de instalação existente e o caminho "parar e explicar"; **S11** rotas admin para apagar projeto e `PATCH /admin/users/{u}` (desvincular nome). Resultado em nota anexa. | API |
| **1. Núcleo memory** | `MemoryAdminClient`, `ensure` do usuário (`u<hex>`, nome do Google), migração, fake do ai-memory, canário | API |
| **2. Proxy MCP** | `tools/list`/`tools/call` filtrados, `memory_status`, limites, `instructions` | API |
| **3. Login de dispositivo** | grant no `/token`, `/oauth/device_authorization`, `DeviceAuthorization`, `POST /memory/computers`, manifesto | API |
| **4. Telas de máquina** | `/device`, Computadores conectados | Mosaico (contrato desta API) |
| **5. Instalador** | repo `ufba-app/memory`: bootstrap, modos `fresh`/`profile`, Windows + Linux/macOS, contas do Maestri, CI | API + review do André |
| **6. Ensino do agente** | `memory_connect_computer`, prompt `conectar computador`, textos | API |
| **7. Meus projetos** | `MemoryProject`/`Member`, convites, reconciliador, `DELETE /me` com as regras de §4.4, rotas web e telas | API + Mosaico |
| **8. Papéis do time e Administração** | `team_roles` semeadas, `UserTeamRole`, rotas `/web/admin/*`, tela Administração | API + Mosaico |
| **9. Endurecimento** | assinatura minisign, rotação da chave de repasse, alertas de limite, runbook | API |

Cada etapa só vai para produção depois de CI verde. Nenhum teste contra SIGAA/AVA reais (esta feature não toca nas fontes).

## 13. Decisões e pontos em aberto

### 13.1 Decididas pelo André (14/11)

(a) chave de repasse por pessoa; (b) root como segredo do `api` e rotação pelo André; (c) memory sem LLM, embedder local mantido; (d) `u<hex>` com nome do Google; (e) sem marcador não captura; (f) sem skills/instruções; (g) contas do Maestri; (h) `DELETE /me`; (i) qualquer pessoa cria projeto; (j) versão fixa. Detalhes em §1.1.

### 13.2 Decididas pelo orquestrador, revisar com o André

- **Teto de computadores** por pessoa: 10 ativos.
- **Usuário "humano" sem login** no memory: a senha temporária é descartada; console web do memory fica **desligado** para as pessoas por ora.
- **Minisign** nos releases: etapa 9 (não na primeira versão).
- **Convite a quem ainda não tem conta**: fica `pending` e vale no primeiro login.
- **Admin** = e-mails da configuração do serviço (`MEMORY_ADMIN_EMAILS`), não tabela editável.
- **Tabela de papéis** só muda por migração/PR (a escrita em `docs` exige revisão).
- **Marcador `.ai-memory.toml`**: o instalador não grava; a tela do projeto mostra o trecho.

### 13.3 Ainda em aberto (precisam de resposta ou do spike)

1. **`--root` do perfil `ufba`:** que pasta(s)? Proposta: o instalador pergunta (sem varrer disco). Repositório fora dos roots fica mudo, por desenho.
2. **Instalação existente mais antiga que 3.4.6:** proposta é **parar e explicar**; a alternativa seria oferecer atualizar o cliente do próprio André, o que mexe no servidor padrão dele e eu não faria sem pedir.
3. **`--capture-mode allowlist` é por instalação:** em `profile` não alteramos, então o que vale para repositórios sem `server` é o que a pessoa já tinha. Confirma?
4. **Agentes TypeScript (`opencode`, `pi`, `omp`, `openclaw`) e scripts** não roteiam perfil: em `profile` ficam fora do suporte (em `fresh` funcionam). Aceita?
5. **Nomes no memory:** workspace `ufba-app` (time: `api`, `web`, `docs`) e `ufba-alunos` (`<slug>-<4 hex>`). Pode ser outro?
6. **Dono que sai de projeto compartilhado:** proposta é transferir ao membro `write` mais antigo; se não houver, o projeto é tratado como pessoal e apagado (já era "único").
7. **Desvincular nome** ao excluir conta: `PATCH` do usuário no memory para nome genérico ("Ex-participante"); `username` já é anônimo. Depende de S11.
8. **Apagar projeto pessoal no memory:** existe `purge-project` no CLI; a rota admin e o aceite do root bearer dependem de S11.
9. **Quem hospeda o fake e o spike:** o spike usa um ai-memory descartável **local** na máquina de dev (sem Docker na máquina, usar o binário nativo `ai-memory`); preciso de OK para baixar o release 3.4.6 na etapa 0.
