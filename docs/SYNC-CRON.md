# Cron de sincronização (Railway)

A sincronização das cópias de fontes externas (hoje só o SIASB) roda num **serviço de cron do Railway**, separado da API, chamado `sync-cron`. O job é genérico: cada fonte entra como um **provedor** (`SyncProvider`) e o runner não conhece nenhuma delas. Padrão igual ao do calendário (`docs/CALENDARIO-CRON.md`).

**Autorização:** o André autoriza antes de qualquer mudança no serviço do Railway. Este documento só descreve o serviço.

## O que o runner faz

`node dist/src/sync-job.js` sobe o contexto do Nest **sem HTTP**, pega a lista `SYNC_PROVIDERS` e roda `runSyncJob` (`src/application/jobs/sync-runner.ts`). Para cada provedor, em ordem:

- pede `provider.dueUsers(agora, provider.maxUsersPerRun)`;
- chama `provider.syncUser` para cada pessoa, em ordem, com `provider.spacingMs` de espaço **entre** pessoas (não depois da última);
- **circuit breaker:** depois de `provider.maxConsecutiveUnavailable` resultados `UNAVAILABLE` seguidos, a rodada **daquele provedor** para; o próximo provedor roda normalmente e quem ficou de fora é pego na próxima execução. Qualquer outro resultado zera a sequência;
- um `syncUser` que lança conta como falha, zera a sequência e não interrompe as demais pessoas;
- se `dueUsers` lança, o provedor é pulado (linha fixa no log) e os demais seguem.

Resultados possíveis de `syncUser` (`SyncOutcome`): `OK`, `RECONNECT_REQUIRED`, `UNAVAILABLE`, `BUSY`, `DISCONNECTED`. Só são contados, sem ação destrutiva.

## Contrato de provedor

`src/application/jobs/sync-provider.ts`:

```ts
interface SyncProvider {
  readonly key: string;                  // nome curto e fixo, usado no log ('siasb')
  readonly maxUsersPerRun: number;
  readonly spacingMs: number;
  readonly maxConsecutiveUnavailable: number;
  dueUsers(now: Date, limit: number): Promise<string[]>;
  syncUser(userId: string): Promise<SyncOutcome>;
}
```

Os limites vivem no provedor, nunca no runner.

## Como adicionar uma fonte

1. Crie `src/application/<fonte>/<fonte>-sync-provider.ts` com uma classe que implemente `SyncProvider` (constantes de limite no próprio arquivo) e o teste correspondente.
2. Em `src/app.module.ts`, registre a classe como provider e acrescente-a ao array devolvido pela factory de `SYNC_PROVIDERS`.
3. Atualize a tabela de limites abaixo. Nenhuma mudança no runner, no entry point nem no Railway.

## Provedores

| `key` | `maxUsersPerRun` | `spacingMs` | `maxConsecutiveUnavailable` | origem |
|---|---|---|---|---|
| `siasb` | 200 | 1500 | 3 | `SiasbSyncProvider`: `SiasbCopyRepository.dueUsers` (só contas com estado `OK`; sem estado primeiro, depois `nextRunAt` crescente) e `SiasbSyncer.syncUser` |

Carga do SIASB: no pior caso, 200 pessoas levam cerca de 5 minutos de espaço, mais o tempo das leituras, bem abaixo dos 30 minutos entre execuções. A trava por pessoa (lease) do sincronizador evita leitura dobrada se uma execução ainda estiver rodando; o Railway também não sobrepõe execuções do mesmo cron.

## Log e código de saída

Só texto fixo e contagens: nunca ids de usuário, nomes, mensagens de erro nem credenciais. Uma linha por provedor:

```
sync: <key> <n> devidos, <ok> ok, <reconnect> reconnect, <unavailable> unavailable, <busy> busy, <disconnected> disconnected, <failed> falhas
```

com o sufixo `, rodada interrompida: provedor indisponível várias vezes seguidas` quando o breaker parou o provedor. Outras linhas fixas: `sync: <key> não foi possível listar quem sincronizar`, `sync: nenhum provedor registrado` e `sync: não foi possível iniciar`.

Código de saída: **0** se a execução rodou (mesmo com falhas por pessoa ou por provedor, e também sem nenhum provedor); **1** se há provedores e `dueUsers` falhou para **todos**, ou se o contexto do Nest não subiu.

## Serviço no Railway

| campo | valor |
|---|---|
| Nome | `sync-cron` |
| Repositório | `ufba-app/api` (o mesmo da API) |
| Build | o mesmo `Dockerfile` |
| Comando de start | `node dist/src/sync-job.js` (**substitui** o `CMD` do Dockerfile, então não roda `prisma migrate deploy`: as migrações continuam sendo da API) |
| Agendamento (cron, UTC) | `*/30 * * * *` |
| Reinício | nunca (o serviço de cron termina sozinho) |

Variáveis (por referência ao serviço da API, sem copiar o valor): `DATABASE_URL` e `SECRETS_KEY` (precisa ser a mesma da API, para abrir a cifra). Não precisa de `WEB_ORIGIN`, `PUBLIC_URL`, das variáveis de Google/Moodle nem de VAPID. `MEMORY_SCHEDULER=off` é imposto pelo próprio job.

O alias `src/siasb-job.ts` (`node dist/src/siasb-job.js`) não existe mais: o start do serviço tem de ser `node dist/src/sync-job.js`.
