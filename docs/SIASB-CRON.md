# Cron do SIASB (Railway)

A sincronização da cópia do SIASB roda num **serviço de cron do Railway**, separado da API, chamado `siasb-cron`. O nome é neutro: a fase de avisos entrará no mesmo job depois (ainda não existe). Padrão igual ao do calendário (`docs/CALENDARIO-CRON.md`).

**Autorização:** o André autoriza antes de o serviço de cron ser criado. A criação fica para depois de a fase 2A estar na `main`; este documento só descreve o serviço, nada foi criado no Railway.

## O que o cron faz

`node dist/src/siasb-job.js` sobe o contexto do Nest **sem HTTP** e, uma vez por execução:

- pede a `SiasbCopyRepository.dueUsers` quem está devido (só contas com estado `OK`; sem estado primeiro, depois `nextRunAt` crescente), no máximo 200 pessoas;
- chama `SiasbSyncer.syncUser` para cada uma, em ordem, com **1500 ms entre pessoas** (não depois da última);
- **circuit breaker:** depois de 3 resultados `UNAVAILABLE` seguidos (`SYNC_MAX_CONSECUTIVE_UNAVAILABLE`), o SIASB é tratado como fora do ar: a rodada para sem processar mais ninguém, o log ganha o texto fixo "rodada interrompida" e a saída é 0. Qualquer outro resultado zera a sequência; quem ficou de fora é pego na próxima execução;
- um `syncUser` que lança não interrompe as demais; `DISCONNECTED` só entra na contagem, sem nenhuma ação destrutiva.

Código de saída: **0** se o laço rodou (mesmo com falhas por pessoa); **1** se `dueUsers` falhou ou o contexto não subiu. O log tem só contagens (`devidos`, `ok`, `reconnect`, `unavailable`, `busy`, `disconnected`, `falhas`): nunca ids de usuário, nomes de paciente nem mensagens de erro.

## Serviço no Railway

| campo | valor |
|---|---|
| Nome | `siasb-cron` |
| Repositório | `ufba-app/api` (o mesmo da API) |
| Build | o mesmo `Dockerfile` |
| Comando de start | `node dist/src/siasb-job.js` (**substitui** o `CMD` do Dockerfile, então não roda `prisma migrate deploy`: as migrações continuam sendo da API) |
| Agendamento (cron, UTC) | `*/30 * * * *` |
| Reinício | nunca (o serviço de cron termina sozinho) |

Variáveis (por referência ao serviço da API, sem copiar o valor): `DATABASE_URL` e `SECRETS_KEY` (precisa ser a mesma da API, para abrir a cifra). Não precisa de `WEB_ORIGIN`, `PUBLIC_URL` nem das variáveis de Google/Moodle. `MEMORY_SCHEDULER=off` é imposto pelo próprio job.

## Carga

- Teto: `SYNC_MAX_USERS_PER_RUN = 200` pessoas por execução.
- Espaço: `SYNC_SPACING_MS = 1500` ms entre pessoas, para não pressionar o SIASB. No pior caso, 200 pessoas levam cerca de 5 minutos de espaço, mais o tempo das leituras, bem abaixo dos 30 minutos entre execuções.
- A trava por pessoa (lease) do sincronizador evita leitura dobrada se uma execução ainda estiver rodando; o Railway também não sobrepõe execuções do mesmo cron.
