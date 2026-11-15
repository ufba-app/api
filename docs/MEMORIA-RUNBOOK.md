# Memória compartilhada: runbook

Para quem opera o serviço (hoje o André). Desenho: `docs/specs/2026-11-14-memoria-ufba.md`; peças do código: `docs/MEMORIA.md`. Nenhum passo abaixo pede para colar segredo em chat, arquivo ou commit. Agentes não leem nem imprimem esses valores e o Railway fica só leitura para eles.

## Segredos e onde ficam

| Segredo | Onde | Quem lê |
|---|---|---|
| Token root do ai-memory | `AI_MEMORY_AUTH_TOKEN` (serviço `memory`) e `MEMORY_ROOT_TOKEN` (serviço `api`) | só o `MemoryAdminClient` (`reveal()` no cabeçalho) |
| Chave de repasse de cada pessoa (`ufba-proxy`) | Postgres, `memory_users` (cifrada com `SECRETS_KEY`) | só o proxy do MCP |
| Chave de cada computador (`aim_`) | só na máquina da pessoa | a API nunca guarda |
| `device_code`, `user_code`, token curto do instalador | Postgres, só hash SHA-256 (10 min) | ninguém |
| `token_pepper` do memory | serviço `memory` | **nunca girar** (ver abaixo) |

## Configuração da API (só nomes)

`MEMORY_URL` (padrão `https://memory.ufba.app`; https obrigatório; nunca `*.up.railway.app`), `MEMORY_ROOT_TOKEN`, `SECRETS_KEY`, `ADMIN_EMAILS`, `MEMORY_INSTALL_MANIFEST_URL` (opcional), `MEMORY_PROXY_KEY_MAX_AGE_DAYS` (opcional, padrão 90), `MEMORY_SCHEDULER=off` (desliga a varredura; use só para diagnóstico). Sem `MEMORY_ROOT_TOKEN` a memória fica "não configurada": o `/mcp` volta a ter só as ferramentas da casa e o resto da API segue igual.

No serviço `memory`: `AI_MEMORY_AUTH_TOKEN`, `AI_MEMORY_ALLOWED_HOSTS`, `AI_MEMORY_AUTH__SECURE_COOKIE=true`, e **`AI_MEMORY_AUTH__RECOVERY_TOKEN`** (32 caracteres ou mais) se ainda não existir um usuário root humano recuperável: com usuários humanos criados, o servidor se recusa a subir sem um deles (`human authentication is enabled but no recoverable root user exists`). Conferir **antes** da primeira pessoa usar a memória.

## Girar o token root

1. `ai-memory generate-auth-token` na máquina do André (sai só no terminal).
2. No Railway, trocar `AI_MEMORY_AUTH_TOKEN` no serviço `memory` e `MEMORY_ROOT_TOKEN` no serviço `api` (preferir variável de referência para não copiar o valor duas vezes).
3. Reimplantar `memory` e depois `api`. Por alguns instantes o proxy responde "memória indisponível"; as ferramentas da casa seguem.
4. Verificar: `memory_status` pelo MCP responde `memory_available: true`; um computador conectado continua capturando (as chaves `aim_` de usuário não dependem do root, confirmado no spike S6).
5. **Nunca girar o `token_pepper` do memory**: invalida todas as chaves `aim_` (computadores e repasse) de todo mundo.
6. Se o token vazar: girar na hora (1 a 4) e olhar o audit log do memory (`grant_access`/`revoke_access`, criação de chaves) no período.

## Chave de repasse de uma pessoa ou de todas

- Automática: a varredura de 10 min gira a chave de repasse com mais de `MEMORY_PROXY_KEY_MAX_AGE_DAYS` dias (20 por execução). Não toca no root.
- Incidente (cópia do banco vazou, mas a `SECRETS_KEY` não): defina `MEMORY_PROXY_KEY_MAX_AGE_DAYS=0` e reimplante; a varredura gira todas em lotes de 20 a cada 10 min. Volte ao padrão depois. Se a própria `SECRETS_KEY` vazou, o problema é maior que a memória (ela também cifra os tokens do Moodle e do Google): trocá-la deixa ilegível tudo o que está cifrado, então é decisão à parte, fora deste runbook.
- Se a gravação da chave nova falhar, a credencial é revogada e a pessoa volta a `creating`: o próximo uso do MCP emite outra sozinho.

## Revogar acessos

- Um computador: pela tela (Computadores conectados) ou `DELETE /memory/computers/{id}`. A chave morre na hora; os hooks daquele computador passam a falhar e param de capturar.
- Uma pessoa inteira: `DELETE /me` (revoga todas as chaves, entrega ou apaga projetos, desativa o usuário no memory). Se o memory estiver fora do ar a exclusão é interrompida (503) e pode ser repetida. `disable` do memory **não** revoga chaves: a API sempre revoga antes.
- Chave de computador emitida e nunca confirmada pelo instalador: revogada pela varredura em 10 min.

## O que olhar

- Log da API, linha `varredura:` a cada 10 min (contagens, sem nomes). `alerta:` aparece quando há pessoas com sincronização falhando ou projetos desconhecidos nos `ufba-*`; `limite de chamadas de memória atingido: user=… tool=…` mostra quem bateu o limite (nunca o conteúdo).
- Tela Administração (`GET /admin/memory/sync`): fila de falhas (só código/status) e projetos que existem no memory e a ufba.app não conhece (criados por escrita direta, S12): adote (crie o registro) ou apague no memory.
- `memory_status` pelo MCP: `memory_available`, `user_ready`, computadores.

## Quando o memory cai

As ferramentas da casa continuam. As `memory_*` somem do `tools/list` e `memory_status` diz que a memória está indisponível. Convites e papéis ficam pendentes (jobs com backoff de 30 s a 30 min) e se resolvem quando ele volta. Hooks locais seguram em fila.

## Atualizar o ai-memory

1. Mudar `VERSION` no repo `ufba-app/memory`; o workflow `image` publica a imagem. Trocar a tag no serviço `memory` do Railway.
2. Rodar `test/memory-proxy.spec.ts` contra a lista real de ferramentas da versão nova: o teste falha se houver ferramenta sem classe em `memory-tool-policy.ts`. Classifique (read, write, destructive, host) antes de liberar; `readOnlyHint` do servidor não vale.
3. Reconferir no spike os pontos que o código assume (docs/MEMORIA.md, "Fatos do ai-memory"), principalmente `disable` sem revogar chaves, 409 em usuário repetido e perfis de servidor.
4. Atualizar o manifesto (versão e SHA-256 dos artefatos) pelo release do instalador. O instalador em modo `profile` para se o cliente da pessoa for mais antigo que a versão fixa.

## Pendências conhecidas

- **Assinatura minisign dos releases do instalador:** não implementada. Precisa de uma chave gerada pelo André (a pública vai no bootstrap e no repositório; a privada fica só em segredo do CI). O hash SHA-256 embutido no bootstrap e o do manifesto continuam sendo a verificação.
- **Backup do volume `/data` do memory** (wiki em git + índice SQLite): não automatizado aqui; conferir o backup do volume no Railway.
- **Privacidade:** nome do Google e `u<hex>` aparecem na autoria das páginas; quem tem acesso a um projeto lê todas as páginas dele (sem RBAC por página). A tela de Meus projetos precisa dizer isso.
