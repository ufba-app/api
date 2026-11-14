# Memória compartilhada (módulo `memory`)

Desenho: `docs/specs/2026-11-14-memoria-ufba.md`; resultado do spike e correções: `docs/specs/2026-11-14-memoria-ufba-spike.md`.

## Estado

| Etapa | Entrega | Estado |
|---|---|---|
| 1 | `MemoryAdminClient`, `MemoryUsers.ensure`, tabela `memory_users`, fake do ai-memory, canário | feito |
| 2 | proxy do MCP (`memory_*` filtrado), `memory_status`, limites, `instructions` | feito |
| 3 a 9 | dispositivo, projetos, papéis, endurecimento | a fazer |

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
- `memory_connect_computer` e o prompt `conectar computador` entram na etapa 6; `os` do computador em `memory_status` na etapa 3 (rótulo `pc:<id>:<nome>`).

## Fatos do ai-memory que o código assume (spike)

- `disable` de usuário **não** revoga chaves `aim_`: sempre revogue as credenciais antes.
- `POST /admin/human-users` responde 409 se o username existe.
- `last_used_at` só aparece depois do primeiro uso da chave.
- O `memory_status` do ai-memory não é repassado (colide com o da casa).
