# Memória compartilhada (módulo `memory`)

Desenho: `docs/specs/2026-11-14-memoria-ufba.md`; resultado do spike e correções: `docs/specs/2026-11-14-memoria-ufba-spike.md`.

## Estado

| Etapa | Entrega | Estado |
|---|---|---|
| 1 | `MemoryAdminClient`, `MemoryUsers.ensure`, tabela `memory_users`, fake do ai-memory, canário | feito |
| 2 a 9 | proxy do MCP, dispositivo, projetos, papéis, endurecimento | a fazer |

## Configuração (só nomes)

- `MEMORY_URL`: URL pública do memory (padrão `https://memory.ufba.app`). https obrigatório (http só em loopback, para testes); nunca `*.up.railway.app`.
- `MEMORY_ROOT_TOKEN`: token root do ai-memory (mesmo valor do `AI_MEMORY_AUTH_TOKEN` do serviço memory). Sem ele a memória fica "não configurada" e o resto da API segue normal.
- `SECRETS_KEY` (já existe): cifra a chave de repasse de cada pessoa.

## Peças

- `application/memory/memory-ports.ts`: porta `MemoryAdmin` (cada operação é um método fixo; nenhuma rota repassa caminho `/admin` arbitrário), repositório e `MemoryAdminError` (só tipo e status, nunca o corpo).
- `application/memory/memory-users.ts`: `ensure(userId, nome)` cria o usuário `u<12 hex>` com o nome do Google (sem e-mail), descarta a senha temporária e guarda a chave de repasse `ufba-proxy` cifrada. Idempotente, retomável (credencial órfã é revogada) e seguro contra chamadas simultâneas.
- `infrastructure/memory/memory-admin.client.ts`: único lugar que dá `reveal()` no token root.
- `infrastructure/memory/testing/fake-ai-memory.ts`: servidor HTTP falso que imita a API de admin do ai-memory 3.4.6 como observada no spike.

## Fatos do ai-memory que o código assume (spike)

- `disable` de usuário **não** revoga chaves `aim_`: sempre revogue as credenciais antes.
- `POST /admin/human-users` responde 409 se o username existe.
- `last_used_at` só aparece depois do primeiro uso da chave.
- O `memory_status` do ai-memory não é repassado (colide com o da casa).
