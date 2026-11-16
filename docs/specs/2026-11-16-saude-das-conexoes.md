# Saúde das conexões

Status: aprovada pelo André em 16/11 (1 sim, 2 depois, 3 não): `source_health` entra; push fica para a v2; sem rota "testar agora". Brief: `dev/ufba/handoffs/saude-das-conexoes.md`.

## Objetivo

Cada conexão da página Conexões mostra se funciona agora; se não, por quê e o que a pessoa faz. Regra: sinais que já existem, sem sondar a fonte e sem varrer nada.

## O que existe hoje (lido do código, nada executado contra fonte real)

| Conexão | Sinal já gravado | Onde |
|---|---|---|
| SIGAA | `cofre.status` OK/REAUTH_NEEDED (senha recusada); a sessão abre o cofre ou não (`locked`); `passkey.slots`; `sigaa_sessions.lastUsedAt` (cookie, 20 min) | `ConnectionStatus.sigaa`, `CofreSigaa`, `sigaa_sessions` |
| Moodle | `source_accounts.status` OK/REAUTH_NEEDED + `statusReason` (código); `expiresAt` e `lastSyncedAt` existem mas **ninguém grava** | `ConsultaService.com` marca REAUTH |
| Classroom | idem, por conta (e-mail). 400/401 do Google (`invalid_grant`) vira REAUTH_NEEDED (`google-errors.ts`) | idem |
| SIASB | `source_accounts.status`, `expiresAt` (estimativa do cookie), `siasb_sync_state` (`result` OK/RECONNECT_REQUIRED/UNAVAILABLE, `lastAttemptAt`, `lastSuccessAt`), `stale` > 3 h (`STALE_AFTER_MS`) | `SiasbLink.status`, `SiasbCopyReader.freshness` |
| Push | `push_devices.lastSuccessAt`; aparelho morto é apagado (`outcome === 'gone'`) e a rota devolve 409 `push_device_gone` | `Notifier`, `PushDevicesService` |
| Memória | `memory_computers.lastSeenAt`; o valor real vem de uma chamada ao ai-memory (`listCredentials`) | `memory-computers.ts` |

**Lacuna principal:** `ConsultaService` não grava nada além de REAUTH_NEEDED. Falhas transitórias (`UNAVAILABLE`, `BLOCKED`, 504 de notas, TLS) e o último sucesso de leitura de SIGAA, Moodle e Classroom não ficam registrados. O SIGAA nem tem linha em `source_accounts` (a senha vive no cofre). Sem isso só se distingue "conectado" de "reconectar".

## Sinal por conexão e custo

Custo de tudo abaixo: leituras de banco no `GET /me` (que já lê quase todas). Nenhuma chamada a fonte externa na v1.

- **SIGAA**
  - `password_required` (cofre REAUTH ou sem passkey) → `action_required`/`password_rejected`.
  - `locked` (passkey existe, sessão não abre) → `action_required`/`locked`, ação "Toque na passkey".
  - Conectado, mas última leitura com `UNAVAILABLE` e sem sucesso depois → `degraded`/`source_unavailable` ("O SIGAA está fora do ar").
  - Conectado e sem leitura registrada (v1, antes de `source_health`) → `ok`; depois da fase 2, sem nenhuma leitura → `unknown`/`never_read`.
  - Sessão viva (`lastUsedAt`) **não** entra na saúde: expirar é normal e o login refaz sozinho.
- **Moodle**
  - REAUTH_NEEDED → `action_required`/`token_revoked` ("Reconecte o AVA").
  - Última leitura `UNAVAILABLE`/TLS → `degraded`/`source_unavailable`.
  - 504 em notas de alguns cursos → `degraded`/`partial_data` (só quando o gateway já marcou o curso como parcial; precisa gravar o aviso).
- **Classroom** (uma saúde por conta)
  - `invalid_grant` → `action_required`/`token_revoked`.
  - App de convidados em modo Teste: o refresh token morre em 7 dias. Gravar `expiresAt = vínculo + 7 d` só para contas do app convidado (a coluna existe e está livre). Faltando ≤ 24 h → `degraded`/`expiring_soon`; passou → `action_required`/`token_expired`.
  - Escopo faltando (drive.readonly) e conta sem acesso: **em aberto**; o código só tem `NO_ACCESS`/`UNSUPPORTED_SCOPE` por requisição, e não verifiquei se o escopo concedido é guardado. Na v1 vira `degraded`/`missing_scope` apenas se o vínculo passar a gravar o escopo.
- **SIASB**
  - `reconnect_required` ou `expiresAt` passado → `action_required`/`session_expired`.
  - `siasb_sync_state.result = UNAVAILABLE` → `degraded`/`source_unavailable`.
  - `stale` (sem sucesso há > 3 h, com sync ligado) → `degraded`/`stale_copy` ("Dados de 5 h atrás").
  - `expiresAt` em ≤ 3 dias → `degraded`/`expiring_soon` (é estimativa; texto diz "deve vencer").
  - Nunca sincronizou → `unknown`.
- **Push e memória (avaliação):** push cabe na mesma tela como linha de "Avisos" (aparelho sem sucesso há muito tempo = `degraded`/`device_silent`; dado já existe). Memória exige chamada ao ai-memory por abertura da tela: **deixar fora da v1**, ou só `lastSeenAt` local sem a chamada. Recomendo: v1 só as quatro fontes; push na v2.

## Novo registro mínimo (único custo de escrita)

Tabela `source_health` (userId, source, accountKey, `lastOkAt`, `lastErrorAt`, `lastErrorCode`, `partial` bool). Chave `(userId, source, accountKey)`.

- Gravada por `ConsultaService.com/comSigaa` ao fim de cada consulta: **só metadados**, nunca mensagem da fonte nem segredo.
- Throttle: sucesso regrava no máximo a cada 10 min por conta; erro regrava só quando o código muda ou a cada 10 min. Uma escrita por consulta no pior caso, sem leitura extra.
- Apagada com a pessoa (cascade). Isso muda a frase do CLAUDE.md "ConsultaService não grava nada"; atualizar junto.
- O SIASB não precisa dela (já tem `siasb_sync_state`).

## Contrato proposto

`health` dentro de cada conexão de `Me.connections` (ao lado de `status`, que não muda). Classroom: um `health` por item de `accounts`.

```ts
HealthState  = "ok" | "degraded" | "action_required" | "unknown"
HealthReason = "password_rejected" | "locked" | "token_revoked" | "token_expired" | "session_expired"
             | "source_unavailable" | "stale_copy" | "partial_data" | "expiring_soon" | "missing_scope" | "never_read"
HealthAction = "reconnect" | "unlock" | "retry" | null

Health = {
  state: HealthState,
  reason: HealthReason | null,   // null quando ok
  message: string,               // pt-BR, uma frase, já com a ação
  action: HealthAction,
  since: string | null,          // ISO 8601: último sucesso (ok/degraded) ou início do problema
}
```

Mensagens de exemplo: "Reconecte o AVA: o acesso foi revogado." · "O SIGAA está fora do ar; tentamos de novo na próxima consulta." · "Toque na passkey para liberar o SIGAA." · "Os dados do SIASB são de 5 h atrás."

Regras:
- Estado fechado; `reason` é enum no contrato (`API_ERROR_CODES` não muda; novo enum `HealthReason`).
- Prioridade: `action_required` > `degraded` > `unknown` > `ok`.
- `message` nunca ecoa texto da fonte, só texto fixo por `reason`.
- Sem rota nova na v1. Rota opcional futura `POST /me/connections/{source}/check` (uma chamada leve, cache 10–15 min por pessoa, só ao abrir a tela) para quem quiser "testar agora"; depende do OK do André para qualquer teste real.
- Mudou o contrato: `npm run openapi`, commit do `openapi.json`, avisar o Mosaico.

## O que a tela mostra (Mosaico implementa)

- Selo no cartão de cada conexão: verde `ok`, alerta `degraded`, vermelho `action_required`, cinza `unknown` (amarelo só da marca).
- Uma frase (`message`) e, quando `action` existir, o botão: `reconnect` abre o fluxo de conexão da fonte, `unlock` a passkey, `retry` recarrega.
- "Atualizado há X" a partir de `since`.
- Classroom: um selo por conta.
- Sem polling: a saúde vem no `GET /me` que a tela já faz.

## Fases

1. Contrato + derivação a partir do que já existe (SIGAA, Moodle/Classroom REAUTH, SIASB). Sem migração.
2. Tabela `source_health` + gravação no `ConsultaService` (degraded por fonte fora do ar, parcial, `never_read`).
3. `expiresAt` de 7 dias nas contas de convidado; escopo do Classroom, se confirmado.
4. Push (e memória, se fizer sentido).

## Decisões do André (16/11)

1. `source_health` (só metadados): sim.
2. Push: v2.
3. Rota "testar agora": não; a saúde é passiva.
