# Notificações (Web Push) e o `notify-cron`

Canal de avisos genérico: qualquer fonte avisa o aluno pelo mesmo caminho; o SIASB é o primeiro cliente. As rotas estão em `docs/WEB-API.md` §5.5.

## Peças

- **`PushSender`** (`WebPushSender`, biblioteca `web-push`): envia com VAPID. Sem as variáveis, ou com valor inválido, o canal fica **desligado** (`enabled = false`): as rotas dão 503 `push_unavailable` e o `Notifier` devolve `'unavailable'`. A chave privada fica num campo privado (`#`) e nunca sai em log, erro nem resposta.
- **`PushDevices`**: aparelhos da pessoa (máx. 10). A assinatura inteira (endpoint, `p256dh`, `auth`) é cifrada com a `SECRETS_KEY` (AES-256-GCM, AAD `push:<userId>:<id>`); em claro só o sha256 do endpoint. O servidor só aceita endpoints de serviços de push de navegador (FCM, Mozilla, Apple, Windows), para o endpoint informado pelo cliente não virar um "faça requisição para qualquer lugar".
- **`NotificationSettings`**: interruptor por tipo de aviso, dirigido por `NOTIFICATION_CATALOG` (sem linha = `defaultEnabled`).
- **`Notifier`**: a API interna que as fontes usam (abaixo).
- **`notify-job`**: o ponto de entrada do cron (`node dist/src/notify-job.js`).

## `Notifier`

```ts
Notifier.send(userId, { key, subject, slotAt, title, body, tag, url? }):
  Promise<'sent' | 'duplicate' | 'disabled' | 'no_device' | 'unavailable' | 'failed'>
Notifier.record(userId, key, subject, slotAt, { suppressed }): Promise<boolean>  // true = gravou, false = já existia
Notifier.lastSentAt(userId, key, subject): Promise<Date | null>                  // ignora os suppressed
Notifier.hasDevices(userId): Promise<boolean>
```

`send` decide, nesta ordem: canal desligado (`unavailable`), ajuste da pessoa (`disabled`), nenhum aparelho (`no_device`), instante já reivindicado (`duplicate`) e então envia. Nunca lança: erro vira `'failed'`.

- **Sem silêncio no canal:** o `Notifier` é **neutro quanto a horário**: envia a qualquer hora, para servir a qualquer fonte e a avisos por gatilho (algo que acabou de acontecer). O silêncio das 22h às 7h é **regra do SIASB**: cada fonte que quiser respeitar um horário decide no próprio `AlertProvider` e simplesmente não chama `send` fora dele. A função pura `inQuietHours(at)` (`src/domain/notifications/quiet-hours.ts`, UTC-3 fixo, intervalo `[22h, 7h)`) está disponível para isso.
- **Anti-duplicata atômica:** a chave única `(userId, key, subject, slotAt)` de `alert_log` é reivindicada **antes** de enviar, com um único `insert` com `skipDuplicates` (`count === 1` = quem gravou envia). Nunca "ler e depois escrever". Duas execuções simultâneas enviam uma vez só.
- **No máximo uma vez:** se o envio não chegou a nenhum aparelho, o instante é devolvido (apagado do registro) e `send` responde `'failed'` (ou `'no_device'` se todos os aparelhos tinham morrido); uma nova tentativa pode reenviar. Se o processo cair entre a reivindicação e o envio, esse aviso se perde (preferimos perder a duplicar).
- **Aparelho morto:** 404/410 do provedor remove o aparelho.
- **Conteúdo:** só `title`, `body`, `tag` e `url` (caminho do painel ou https; outro valor é ignorado), com TTL de 6 h e urgência alta. A `tag` faz o aviso novo substituir o anterior no aparelho. O conteúdo é de quem envia: **sem dado de paciente** (o `subject` também entra no registro, então nada de dado pessoal de terceiros nele).
- **Log:** nenhum com endpoint, chaves ou texto do aviso.

`record(..., { suppressed: true })` marca um instante como avisado sem enviar (ex.: avisos vencidos que não valem mais, depois de uma queda); `lastSentAt` só olha os envios de verdade.

## `notify-cron`

`node dist/src/notify-job.js`, a cada 15 minutos (`*/15 * * * *`), serviço próprio no Railway. Só lê o banco (nenhuma requisição às fontes) e envia pelo `Notifier`.

- Cada fonte implementa **`AlertProvider`**: `{ key, usersToEvaluate(), evaluateUser(userId, now) → { sent, suppressed, skipped, failed } }`. `evaluateUser` nunca lança e só envia pelo `Notifier`.
- Os provedores entram em **`ALERT_PROVIDERS`** (`src/mcp-wiring.ts`; hoje a lista é vazia: a fonte injeta o que precisa na fábrica e devolve o provedor).
- O runner (`runNotifyJob`) percorre os provedores, isola o erro por provedor e por pessoa (conta como falha), loga **só contagens**, uma linha por provedor (`notify[siasb]: 12 pessoas, 3 enviados, 1 suprimidos, 8 pulados, 0 falhas`), e sai **0** se rodou (inclusive sem provedor ou com falhas por pessoa) ou **1** se não deu para listar as pessoas de **nenhum** dos provedores.
- O `sync-job` (sincronização das fontes) é outro cron e é do Prontuário.

## Variáveis (só os nomes; o André gera e configura)

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` ou `https:`). Valem **por ambiente**, na API e no `notify-cron`. Sem elas o canal fica desligado. O `notify-cron` também precisa de `DATABASE_URL` e `SECRETS_KEY`, como os outros crons. A chave privada nunca é impressa.

## Railway (feito pelo orquestrador, com OK do André)

Criar o serviço `notify-cron` com start `node dist/src/notify-job.js`, cron `*/15 * * * *`, sem healthcheck, e as variáveis por referência ao serviço `api`. Nada é apagado sem o André pedir.
