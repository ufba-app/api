# Memória compartilhada (módulo `memory`)

Desenho: `docs/specs/2026-11-14-memoria-ufba.md`; resultado do spike e correções: `docs/specs/2026-11-14-memoria-ufba-spike.md`.

## Estado

| Etapa | Entrega | Estado |
|---|---|---|
| 1 | `MemoryAdminClient`, `MemoryUsers.ensure`, tabela `memory_users`, fake do ai-memory, canário | feito |
| 2 | proxy do MCP (`memory_*` filtrado), `memory_status`, limites, `instructions` | feito |
| 3 | login de dispositivo, `POST /memory/computers`, confirmação, manifesto, rotas do web | feito |
| 4 a 9 | telas, instaladores, conectar computador, projetos, papéis, endurecimento | a fazer |

## Configuração (só nomes)

- `MEMORY_URL`: URL pública do memory (padrão `https://memory.ufba.app`). https obrigatório (http só em loopback, para testes); nunca `*.up.railway.app`.
- `MEMORY_ROOT_TOKEN`: token root do ai-memory (mesmo valor do `AI_MEMORY_AUTH_TOKEN` do serviço memory). Sem ele a memória fica "não configurada" e o resto da API segue normal.
- `SECRETS_KEY` (já existe): cifra a chave de repasse de cada pessoa.

## Peças

- `application/memory/memory-ports.ts`: porta `MemoryAdmin` (cada operação é um método fixo; nenhuma rota repassa caminho `/admin` arbitrário), repositório e `MemoryAdminError` (só tipo e status, nunca o corpo).
- `application/memory/memory-users.ts`: `ensure(userId, nome)` cria o usuário `u<12 hex>` com o nome do Google (sem e-mail), descarta a senha temporária e guarda a chave de repasse `ufba-proxy` cifrada. Idempotente, retomável (credencial órfã é revogada) e seguro contra chamadas simultâneas.
- `infrastructure/memory/memory-admin.client.ts`: único lugar que dá `reveal()` no token root.
- `infrastructure/memory/testing/fake-ai-memory.ts`: servidor HTTP falso que imita a API de admin do ai-memory 3.4.6 como observada no spike.

## Proxy do MCP (etapa 2)

- `POST /mcp` ganha as ferramentas `memory_*` quando `MEMORY_ROOT_TOKEN` está definido (senão o /mcp é só o da casa, sem `instructions`).
- `application/memory/memory-tool-policy.ts`: lista de permissão **por nome**, padrão negar (`read` e `write` passam; `destructive` e `host` não; `memory_status` do memory não é repassada). `readOnlyHint` do servidor é ignorado. Ferramenta nova do memory fica fora até alguém classificá-la; `test/memory-proxy.spec.ts` falha se o fake (e, na atualização de versão, o `tools/list` real) trouxer nome sem classe.
- `application/memory/memory-proxy.ts` (`MemoryProxy`): usa a chave de repasse da pessoa (nunca a root), não altera argumentos nem resultado, exige `workspace` e `project` explícitos e **registrados** (recusa `workspace_id`/`project_id`), 1 MB por chamada, 30 chamadas/min por pessoa, catálogo em cache por 5 min. Erros viram mensagens fixas em pt-BR, nunca o corpo do memory. Memory fora do ar: só `memory_status` (com `memory_available: false`).
- `MemoryProjectRegistry`: hoje o conjunto semeado `ufba-app/{api,web,docs}` (S12). A etapa 7 troca pela tabela de projetos; até lá o proxy não aceita projetos de pessoa/alunos.
- `MemoryAccess`: gancho de quem pode usar a memória. Hoje aberto; a etapa 8 liga aos papéis do time (sem acesso não cria usuário no memory).
- `interface/mcp/mcp-tools.ts`: o `McpServer` só registra Zod; `tools/list` e `tools/call` são decorados em `addMemoryTools` (usa `_requestHandlers` do SDK 1.32; o teste de contrato quebra se o SDK mudar).
- `memory_connect_computer` e o prompt `conectar computador` entram na etapa 6; `os` do computador em `memory_status` vem de `memory_computers`.

## Login de dispositivo e computadores (etapa 3)

Fluxo (RFC 8628) do instalador, passo a passo, com o que a API grava:

1. `POST /oauth/device_authorization` (form: `client_id=ufba-installer`, `scope=memory:connect`, opcionais `computer_name`, `os`) devolve `device_code`, `user_code` (`XXXX-XXXX`), `verification_uri(_complete)`, `expires_in: 600`, `interval: 5`. Limites: 10 pedidos/h e 20 em aberto por IP. Só hashes SHA-256 vão ao banco (`device_authorizations`).
2. `POST /token` com `grant_type=urn:ietf:params:oauth:grant-type:device_code`: `authorization_pending`, `slow_down` (+5 s), `access_denied`, `expired_token`, `invalid_grant`; no máximo 120 consultas por código.
3. Na tela `/device` (sessão do web): `POST /web/device/lookup` mostra quem pediu (nome, sistema, hora, rede aproximada, aviso se a rede de quem aprova é bem diferente) e `POST /web/device/decision` aprova ou nega. Palpite errado: 5 por pessoa e 20 por IP a cada 10 min (429 `too_many_attempts`).
4. Aprovado, o próximo `/token` entrega o **token curto** (10 min, escopo `memory:connect`, sem refresh, sem a chave K). Ele **não** é um token OAuth do serviço: vive só em `device_authorizations`, então `/mcp`, a API de dados e o web não o aceitam.
5. `POST /memory/computers` (Bearer = token curto) `{name, os, computer_id?, agents?, client_version?, install_mode?}` devolve `{computer_id, username, memory_url, key}` (a chave **uma vez**, `no-store`). Com `computer_id` conhecido da mesma pessoa, troca a chave dele (`rotate`); de outra pessoa, é ignorado. Limites: 5 conexões/h por pessoa e 10 computadores ativos (409 `computer_limit_reached`).
6. `POST /memory/computers/{id}/confirm` (mesmo Bearer): o instalador diz que **gravou** a chave. Só aí o computador passa a valer (aparece na lista) e o token é consumido. Sem confirmação em 10 min, `MemoryComputers.sweep()` revoga a chave (roda a cada nova conexão da pessoa; um agendador geral entra na etapa 9).

A API guarda só `credentialId` e a prévia da chave. Rótulo da credencial no memory: `pc:<8 hex do id>:<nome>`. Credencial `pc:` sem linha no banco (queda entre emitir e gravar) é órfã: o reconciliador da etapa 7 revoga.

Rotas do web (no `openapi.json`, prefixo `/web`): `device/lookup`, `device/decision`, `memory/status`, `memory/computers` (GET, PATCH `{id}`, DELETE `{id}`). Rotas do instalador (fora do contrato): `POST /memory/computers`, `POST /memory/computers/{id}/confirm`, `GET /memory/install-manifest`.

### Manifesto de instalação

`GET /memory/install-manifest` serve o JSON do release de `ufba-app/memory`, gerado pelo CI a partir do mesmo artefato do bootstrap (um só dono do hash). A API valida, guarda 10 min e serve o último bom se a origem cair (503 `memory_unavailable` se nunca houve um). Origem: `MEMORY_INSTALL_MANIFEST_URL` (https, só `github.com`; padrão: `releases/latest/download/manifest.json` do repo `ufba-app/memory`). Formato (`schema: 1`):

```json
{
  "schema": 1,
  "aiMemory": { "version": "3.4.6", "artifacts": { "windows-x64": { "url": "https://github.com/...", "sha256": "<64 hex>" } } },
  "installer": { "version": "1.0.0", "minVersion": "1.0.0", "files": { "install.ps1": "<64 hex>", "install.sh": "<64 hex>" } }
}
```

### Configuração nova (só nomes)

- `MEMORY_ADMIN_EMAILS`: e-mails (separados por vírgula) dos administradores; hoje só alimenta `isAdmin` em `GET /web/memory/status` (a Administração é a etapa 8).
- `MEMORY_INSTALL_MANIFEST_URL`: ver acima.

## Fatos do ai-memory que o código assume (spike)

- `disable` de usuário **não** revoga chaves `aim_`: sempre revogue as credenciais antes.
- `POST /admin/human-users` responde 409 se o username existe.
- `last_used_at` só aparece depois do primeiro uso da chave.
- O `memory_status` do ai-memory não é repassado (colide com o da casa).
