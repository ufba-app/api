# Cron do calendário acadêmico (Railway)

A leitura semanal de `supac.ufba.br/calendario-academico` roda num **serviço de cron do Railway**, separado da API. Não há agendador dentro da API: a API só mostra os alertas (`GET /admin/calendar/alerts`), marca "Visto", reprocessa um arquivo (`POST /admin/calendar/logs/{id}/reprocess`) e entrega o calendário publicado (`GET /calendar`). Desenho e regras: `dev/ufba/handoffs/calendario-cron-e-alerta-admin.md`; rotas em `docs/WEB-API.md` §5.2.

## O que o cron faz

`node dist/src/calendar-job.js` sobe o contexto do Nest **sem HTTP**, roda `CalendarWatcher.run()` uma vez e termina:

- baixa a página da SUPAC e acha os PDFs de calendário (o texto do link é o semestre);
- só lê arquivo novo ou alterado (URL e SHA-256); sem novidade, a execução custa uma requisição à página e nenhuma chamada à IA;
- lê o PDF com o Haiku 5.5 (~US$ 0,01) e confere por aritmética; uma releitura antes de registrar `NOT_VERIFIED` ou `ERROR`;
- registra cada arquivo em `calendar_parse_logs`; `PUBLISHED` é o calendário vigente do semestre.

Código de saída: **0** se a leitura rodou (inclusive quando a página falhou: isso vira `ERROR` no log e alerta no painel); **1** se a execução inteira falhou (sem `ANTHROPIC_API_KEY`, outra leitura já em andamento no mesmo processo, ou exceção). Loga só contagens, nunca conteúdo de PDF, nomes nem mensagem de erro.

## Serviço no Railway

O `railway.json` da raiz é da **API** (healthcheck `/health`, reinício em falha) e vale para todo serviço deste repo que o use. O cron tem config própria, **`railway.cron.json`**: aponte o serviço `calendar-cron` para ele (Settings → Config-as-code → caminho do arquivo, `railwayConfigFile`).

| campo | valor (vem de `railway.cron.json`) |
|---|---|
| Repositório | `ufba-app/api` (o mesmo da API) |
| Build | `Dockerfile` |
| Comando de start | `node dist/src/calendar-job.js` (**substitui** o `CMD` do Dockerfile, que é quem roda `prisma migrate deploy`: o job **não** migra; as migrações continuam sendo da API) |
| Agendamento (cron, UTC) | `0 9 * * 1`: toda segunda às 09:00 UTC (06:00 em Salvador) |
| Healthcheck | nenhum (o job não tem HTTP) |
| Reinício | `NEVER` (uma saída com código 1 não repete a leitura da SUPAC) |

Variáveis (por referência ao serviço da API, sem copiar o valor):

| var | para quê |
|---|---|
| `DATABASE_URL` | o log (`calendar_parse_logs`) |
| `ANTHROPIC_API_KEY` | a leitura pela IA; sem ela o job sai com código 1 |
| `SECRETS_KEY` | o contexto da aplicação sobe com a cifra; precisa ser a mesma da API |

Não precisa de `WEB_ORIGIN`, `PUBLIC_URL` nem das variáveis de Google/Moodle. `MEMORY_SCHEDULER=off` é imposto pelo próprio job.

A trava contra execução simultânea é do processo (`running` no verificador). O Railway não sobrepõe execuções do mesmo cron; se uma execução anterior ainda estiver rodando, a nova é pulada pelo próprio Railway.

## Admins

Os alertas e o "Reprocessar" valem só para os e-mails de `ADMIN_EMAILS` no serviço **da API** (o cron não precisa dela).

## Primeira execução

Lê a SUPAC real e chama a IA (~1 centavo): rode só com o André olhando o painel. Na primeira vez ela lê só o calendário mais recente; os anteriores não entram no log.
