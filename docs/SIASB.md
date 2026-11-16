# SIASB (clínicas)

O SIASB é o sistema das clínicas-escola da UFBA. A integração deixa a pessoa, pelo Claude, ver a situação nas disciplinas de clínica, as sessões, os pacientes em atendimento e o **prazo estimado** para marcar paciente. É **só leitura**. As ferramentas `clinica_*` vão ao SIASB na hora, com a conexão que a pessoa fez; a exceção é a cópia de sessões e atendimentos feita por cron (seção 10).

Desenho completo: `docs/superpowers/specs/2026-11-15-siasb-design.md`. Ferramentas MCP: tabela abaixo e `docs/MCP.md`. Rotas do web: `docs/WEB-API.md`, seção 5.

## 1. Como funciona

- **Fonte e porta próprias.** O SIASB não passa pela `LiveSource` (que serve Moodle, Classroom e SIGAA). A porta é `SiasbSource` (`src/application/ports/siasb-source.ts`) e a implementação é o `SiasbClient` (`src/infrastructure/sources/siasb/siasb-client.ts`), com o mapeador `siasb-mapper.ts` (lista de campos permitidos).
- **A conexão é uma `SourceAccount`** com `provider = SIASB` (chave `siasb`, uma por pessoa). O que fica guardado é o **jar de cookies**, cifrado com a `SECRETS_KEY` do servidor (`session-codec.ts` serializa; só cifrado vai ao banco), mais a **data de expiração** do cookie.
- **A senha é usada uma vez** (um único login, sem repetição, para não bloquear a conta) e **nunca é guardada**. Ela circula como `Secret` e só é aberta (`reveal()`) dentro de `SiasbClient.login`.
- **Leitura.** O `SiasbReader` (`src/application/siasb/siasb-reader.ts`) abre o jar, consulta ao vivo e, se o SIASB renovou algum cookie, grava o jar de volta (último a gravar vence; a trava por pessoa fica para a fase 2). Falha ao regravar nunca troca o resultado da leitura.
- **Sem conta SIASB, conta marcada ou jar ilegível** a leitura responde "Sua conexão com o SIASB expirou. Entre de novo no painel." (`reconnect_required` no `/me`).

## 2. Fluxo de login

Casos de uso em `src/application/siasb/siasb-link.ts` (`SiasbLink`):

1. **Oferta (`offer`).** O web só mostra "Conectar SIASB" quando a pessoa tem matrícula (gravada ao confirmar a importação da vida acadêmica; não depende de reconectar o SIGAA) **e** `GET /auth/course-options?username=<matrícula>` devolve ao menos um curso. A matrícula **nunca é pedida à mão**: sai do perfil (só os dígitos são usados). Quem já tem conexão só precisa da matrícula importada: se ela for apagada (`DELETE /me/academic`), `offered` vira `false` sem consultar o SIASB, o `status` não muda e um novo login é recusado com a mensagem de importar a vida acadêmica. A lista de cursos fica 10 min em cache; uma falha ao listar vale "não oferecido" por 1 min, para o `/me` não bater no SIASB enquanto ele está fora.
2. **Conexão (`connect`, `POST /connections/siasb { password }`).**
   - confere o vínculo (`assertCompatible`) **antes** de falar com o SIASB;
   - lista os cursos e escolhe o padrão (`isDefault`) ou o primeiro;
   - faz **um** login; o SIASB devolve o `username` da sessão;
   - se o `username` (só dígitos) não for a matrícula da pessoa: `409 source_account_mismatch`, nada é guardado;
   - só então grava o vínculo (`bind`) e a `SourceAccount` com o jar cifrado e o fim do cookie.
3. **Desconexão (`DELETE /connections/siasb`).** Apaga o jar. O vínculo com a matrícula **fica** (para trocar a matrícula, `DELETE /me` e entrar de novo).

**Vínculo fixo por matrícula.** `siasbSubject(matrícula)` (`src/domain/identity/source-binding.ts`): só o HMAC do titular é gravado, nunca a matrícula. A mesma regra do SIGAA e do AVA: `source_account_taken` (409), `source_account_mismatch` (409).

## 3. O cookie

- **Validade de 30 dias, tratada como fixa.** O spike de 15/11/2026 mostrou que o cookie vale de outro IP e de outro navegador, e que o `Expires` não desliza com o uso. O servidor guarda o maior `Expires` visto.
- **Qualquer 401 ou 403 vira `reconnect_required`.** Duas sessões morreram cedo no spike sem explicação, então o código trata a perda a qualquer momento: a conta vai a `REAUTH_NEEDED` e a pessoa conecta de novo no painel. Uma data de expiração já passada também conta como `reconnect_required` no `/me`.
- **Nomes de cookie nunca vão para log.** Um dos cookies do SIASB leva a **matrícula no próprio nome**. Mensagens de erro do cliente são fixas: sem corpo de resposta, sem erro original, sem nome nem valor de cookie, sem matrícula. Os testes canário cobrem isso.
- Redirecionamento nunca é seguido (`redirect: 'error'`): um 307/308 reenviaria o corpo do login, com a senha, a outro host.

## 4. Rotas do SIASB

Base `https://api.siasb.ufba.br/api/v1`. **Só GET**, fora o login. A lista fica num lugar só (`ALLOWED` em `siasb-client.ts`); cada item casa o caminho inteiro, com a query. O que não casa vira `FORBIDDEN_ROUTE` **antes de qualquer rede**.

Permitidas:

| Rota | Para quê |
|---|---|
| `POST /auth/login` | Login (único POST; não repete) |
| `GET /auth/course-options?username=<dígitos>` | Cursos da matrícula (oferta e login) |
| `GET /auth/session` | `username` da sessão, se o login não o trouxe |
| `GET /student/new-attendance/disciplines` | Disciplinas de clínica do semestre |
| `GET /student/attendances?status=1`, `2` ou `3` | Atendimentos da pessoa (o código usa 1 = ativos e 2 = inativos) |
| `GET /student/schedule/sessions?startAt=<data>&endAt=<data>` | Sessões no intervalo (`YYYY-MM-DDTHH:mm`, Bahia) |
| `GET /student/options?kind=procedures&attendanceId=<id>` | Catálogo de procedimentos do atendimento |
| `GET /student/options?kind=ambulatoryLocations`, `professors` ou `patientGroups` (com `attendanceId` opcional) | Listas de apoio |
| `GET /student/unassigned-attendances` | **Só contagem** (`unassignedCount`, fora da lista `ALLOWED`) |

Proibidas (nunca chamadas):

- `student/attendances?status=4` (pacientes de outros alunos) e qualquer outro `status`;
- qualquer rota de dado clínico (prontuário, anamnese, exames, documentos);
- qualquer método que não seja GET (exceto o login);
- rotas administrativas e de escrita (agendar, desmarcar): ficam para a fase 4 e pedem OK específico;
- caminho com `..`, barra dupla, fragmento ou parâmetro fora do formato acima.

GET repete até 2 vezes, só em 5xx ou falha de rede. 429 e redirecionamento viram `UNAVAILABLE`; timeout de 15 s por chamada.

## 5. Privacidade

- **Só o primeiro nome** do paciente, mais disciplina, tipo de tratamento, horário, local e professor. Sobrenome, prontuário e qualquer registro clínico **não passam** pelo mapeador.
- **A lista de pacientes sem responsável nunca sai do cliente.** `clinica_vagas` devolve só números por disciplina; os nomes de terceiros dessa lista são descartados no `siasb-mapper` (`countUnassigned`).
- Nada de paciente vai a log, erro ou auditoria. O procedimento que o aluno cita em `clinica_contexto_agendamento` serve só para a estimativa do modelo e nunca é enviado ao SIASB (a busca no catálogo é local).

## 6. Estados e prazo estimado

Por disciplina de clínica (`src/domain/siasb/clinical-state.ts`):

| Estado | Significa | Valor na ferramenta |
|---|---|---|
| ① | sem atendimento ativo | `sem_paciente` |
| ② | atendimento ativo e nenhuma sessão futura | `sem_sessao` |
| ③ | atendimento ativo e ao menos uma sessão futura | `sessao_marcada` |

"Marcada" = situação Confirmado, Nova, Agendado pelo sistema ou Solicitação de reagendamento. Desmarcado, Cancelada, Atendido e Falta não contam; rótulo desconhecido também não. Só vimos os códigos 1 e 2 em dados reais.

**O prazo é estimado**, e todo texto diz "prazo estimado" (nunca o prazo oficial): o do SIASB é configuração do curso, em horas úteis, e o aluno não consegue lê-la.

- Regra (`src/domain/siasb/deadline.ts`): **2 dias úteis** antes do início da sessão, mantendo o horário; dia útil = não é sábado, domingo nem feriado, na data da Bahia.
- **Margem.** Os feriados vêm da porta `AcademicCalendar` (`src/application/ports/academic-calendar.ts`), implementada por `PublishedAcademicCalendar` (`src/application/siasb/published-academic-calendar.ts`) a partir dos calendários SUPAC publicados (`nonTeachingDays`; cache de 60 s). Quando o intervalo consultado está inteiro dentro dos semestres publicados, `known: true`, os feriados entram e **não há margem**. Fora deles (vão entre semestres, depois do último calendário) ou sem calendário/erro no banco, `known: false`: **soma-se 1 dia útil de margem** (o erro cai para o lado de o aluno chegar cedo) e a resposta traz `feriadosConsiderados: false` com o aviso "Feriados e recessos não considerados; confirme o prazo no SIASB."
- O horário de cada clínica é **deduzido do histórico** de sessões da disciplina (janela de 60 dias para trás). Sem histórico, não há horário nem prazo. Se o prazo do próximo horário já passou, vale o da semana seguinte.

## 7. Ferramentas MCP

As 7 ferramentas (`src/interface/mcp/clinica-tools.ts`). **Visibilidade:** aparecem para a pessoa que tem conexão SIASB **em qualquer estado** (conectada ou a reconectar); sem conexão, não existem na lista. A decisão é por requisição e, se falhar ao resolver, vale "não mostrar" (nunca derruba o MCP).

| Ferramenta | Entrada | Devolve | Chamadas ao SIASB (máx.) |
|---|---|---|---|
| `clinica_situacao` | nenhuma | por disciplina: `estado`, `proximaClinica`, `prazoEstimado` (`null` em `sessao_marcada`), `feriadosConsiderados` | 3 (disciplinas, atendimentos ativos, sessões) |
| `clinica_sessoes` | `de?`, `ate?` (ISO; padrão: próximos 14 dias; até 45 dias à frente) | sessões: disciplina, início, fim, local, professor, primeiro nome, situação, `reagendamentoPara` | 0 (lê da cópia); 1 com `aoVivo: true` ou com período fora da janela sincronizada (leitura ao vivo) |
| `clinica_prazo_marcacao` | exatamente um: `disciplinaId` ou `inicioSessao` | `prazoEstimado`, `feriadosConsiderados` | 1 com `disciplinaId`; 0 com `inicioSessao` |
| `clinica_pacientes` | nenhuma | atendimentos ativos por disciplina: `atendimentoId`, `primeiroNome`, `tipo` (`triagem`, `planejamento`, `urgencia`, `desconhecido`) | 2 |
| `clinica_vagas` | nenhuma | `vagas` (contagem) por disciplina | 2 |
| `clinica_contexto_agendamento` | `atendimentoId`, `busca?` | duração da sessão, sessões já feitas (janela de 60 dias), procedimentos (50 primeiros ou filtrados por `busca`), até 3 próximos horários com prazo estimado | 4 (atendimentos, disciplinas, sessões, procedimentos) |
| `clinica_progresso` | `desde?` e `ate?` (os dois ou nenhum; até 190 dias) | por disciplina: ativos, concluídos no período e no histórico, sessões atendidas e marcadas adiante; ritmo; avisos | 4 (disciplinas, ativos, inativos, sessões) |

Todas leem ao vivo, não gravam, e mostram horários com offset da Bahia (`-03:00`).

### `clinica_progresso`: constantes e ritmo

Em `src/application/siasb/progress.ts`:

| Constante | Valor | Papel |
|---|---|---|
| `PROGRESS_DEFAULT_DAYS` | 120 | período padrão (últimos 120 dias até agora) quando não há `desde`/`ate`; é aproximado e a resposta marca `ePadrao` |
| `PROGRESS_MAX_DAYS` | 190 | maior período aceito |
| `SIASB_AGENDA_DAYS` | 59 | o site do SIASB carrega ~59 dias de agenda; acima disso a resposta traz o aviso de **dado parcial** ("O SIASB pode devolver só parte do período pedido; confira os números.") |

Uma só consulta de sessões cobre do início do período até o maior entre o fim e agora + 45 dias (para contar as marcadas adiante), estendida só quando o fim está ao alcance dessa janela. Nenhuma chamada ao SIASB passa de 190 dias (`clinica_sessoes` puxa o início para 190 dias antes do fim) e `de` depois de `ate` é recusado antes de consultar. A lista de atendimentos não traz data de conclusão: "concluídos no período" = concluído com alguma sessão no período; "no histórico" = todos os concluídos.

**Ritmo (semântica).** Calculado só sobre a parte **decorrida** do período, `[início, min(fim, agora)]`. As semanas são **blocos de 7 dias a partir do início do período** (não semanas de calendário). Só blocos completos podem ser "semana sem sessão": o último bloco, parcial, e blocos que começam depois de agora nunca contam. `sessoesPorSemana` = sessões atendidas ou marcadas ÷ semanas decorridas, e é `null` com menos de 1 dia decorrido. Período que ainda não começou: ritmo não calculado e aviso próprio. `horariosHabituais` vêm dos horários deduzidos do histórico.

## 8. Fuso

Os horários do SIASB são **horário da Bahia, UTC-3 fixo** (sem horário de verão). Na entrada e na saída o servidor converte (`src/domain/siasb/time.ts`); a API devolve ISO com offset `-03:00`. Datas sem hora, nas ferramentas, valem a hora da Bahia (`ate` = fim do dia).

## 9. Web: rotas e erros

Detalhes em `docs/WEB-API.md`.

| Rota | Resposta |
|---|---|
| `POST /connections/siasb { "password": "string" }` | 204 |
| `DELETE /connections/siasb` | 204 (mantém o vínculo; apaga a cópia) |
| `POST /connections/siasb/sync` | 204 (sincroniza agora) |
| `GET /me/siasb/sessions?from=&to=` | `{ syncedAt, stale, items }` |
| `GET /me` → `connections.siasb { offered, status, expiresAt, syncedAt }` | `status`: `connected`, `reconnect_required` ou `disconnected` |

Erros da conexão:

| Status | `error` | Quando |
|---|---|---|
| 400 | `invalid_request` | corpo inválido, ou a pessoa não tem matrícula (a vida acadêmica precisa estar importada) |
| 409 | `source_account_mismatch` | a conta do SIASB não é a da matrícula (ou a conta já está ligada a outra matrícula) |
| 409 | `source_account_taken` | essa matrícula já está ligada a outra conta do ufba.app |
| 422 | `siasb_credentials_rejected` | o SIASB recusou a matrícula ou a senha |
| 422 | `siasb_password_migration_required` | a pessoa precisa entrar uma vez no SIASB para atualizar a senha |
| 429 | `too_many_attempts` | mais de 5 tentativas de conectar em 10 minutos (por pessoa) |
| 503 | `siasb_unavailable` | o SIASB não respondeu (fora do ar, 429, página inesperada) |

## 10. Sincronização (fase 2A)

Desde a fase 2A o SIASB tem uma exceção à leitura ao vivo: um **cron do Railway** (cron `sync-cron`, `docs/SYNC-CRON.md`) copia as sessões e os atendimentos de cada pessoa conectada para as tabelas `siasb_*`. O painel e a ferramenta `clinica_sessoes` leem dessa cópia, sem ir ao SIASB a cada pedido. A senha continua sem ser guardada; o job usa o jar de cookies da conexão.

**O que a cópia guarda** (`prisma/models/siasb/siasb-copy.prisma`): por sessão, disciplina, professor, local, horário, horário reagendado e rótulo da situação; por disciplina (`siasb_disciplines`), id e nome; por atendimento, disciplina, tipo de tratamento, se foi concluído, se veio da consulta de atendimentos **ativos** (`siasb_attendances.active`) e o **primeiro nome** do paciente, **cifrado** com a `SECRETS_KEY` (AES-256-GCM, com o id da pessoa e do atendimento como dado associado). O estado (`siasb_sync_state`) guarda a última tentativa, o último sucesso, o resultado, a próxima execução e a trava.

**O que NÃO guarda:** sobrenome, prontuário, texto de procedimento e qualquer dado clínico. Não passam do mapeador. A lista de pacientes sem responsável também não é copiada.

**Janela:** de 120 dias para trás a 45 dias à frente. Cada sincronização substitui as sessões dentro da janela e mantém as de fora; os atendimentos são substituídos por inteiro.

**Estados de uma tentativa** (`SiasbSyncer.syncUser`):

| Resultado | O que faz |
|---|---|
| `OK` | grava a cópia e agenda a próxima em 45 minutos |
| `RECONNECT_REQUIRED` | o SIASB recusou o cookie; não agenda nova tentativa (a pessoa reconecta no painel) |
| `UNAVAILABLE` | o SIASB não respondeu; tenta de novo em 15 minutos; o último sucesso e a cópia anterior ficam |
| `BUSY` | outra execução da mesma pessoa está em curso (trava de 10 minutos); nada é feito |
| `DISCONNECTED` | a pessoa não tem mais conta SIASB; nada é gravado |

**`stale`:** o painel e o `clinica_sessoes` avisam que a cópia está velha quando nunca houve sincronização, a última tentativa falhou ou o último sucesso tem mais de 3 horas.

**Quando sincroniza:** pelo cron (a cada 30 minutos, só quem está devido), logo após conectar e pelo botão "Sincronizar agora" (`POST /connections/siasb/sync`, 3 por 10 minutos por pessoa).

**Desconectar** (`DELETE /connections/siasb`) apaga a **conta SIASB primeiro** e **só depois** a cópia e o estado (`SiasbLink.disconnect`). Essa ordem evita cópia órfã: a gravação da cópia trava a linha da conta, então uma desconexão concorrente espera a gravação terminar e a limpeza seguinte apaga o que foi gravado. Se a limpeza falhar, o erro volta para a pessoa tentar de novo (desconectar é idempotente). `DELETE /me` apaga tudo em cascata.

**Teste de integração:** o repositório da cópia tem um spec contra Postgres de verdade (`prisma-siasb-copy.repository.int.spec.ts`) que só roda no CI com `RUN_DB_TESTS=1`, no Postgres efêmero do workflow. Nunca o rode contra um banco compartilhado.

## 11. Avisos por push (fase 2B)

Os avisos usam o canal genérico (`docs/NOTIFICACOES.md`) e leem **só a cópia do banco** (nenhuma requisição ao SIASB). O código está em `src/application/siasb/siasb-alerts.ts` (decisão e textos), `src/domain/siasb/alert-schedule.ts` (instantes) e `src/domain/siasb/alert-format.ts` (datas em pt-BR).

### O que avisa e quando

Avisa por disciplina, só nos estados **① sem paciente** e **② sem sessão marcada** (`NO_PATIENT` e `NO_SESSION`), quando há **prazo estimado conhecido** (um próximo horário da clínica deduzido do histórico, seção 6). O estado **③ com sessão marcada nunca avisa**. O prazo é sempre uma estimativa.

**Cadeia de avisos de um prazo.** Os instantes dependem só do prazo, nunca de quando o estado foi visto:

- o **último aviso** é 6 horas **acordado** antes do prazo (o silêncio das 22h às 7h da Bahia não conta nessas 6 horas);
- os anteriores ficam de **36 em 36 horas**, contados para trás a partir do último; o que cairia no silêncio recua para as 21h; o penúltimo some se ficar a menos de 12 h do último; a cadeia não passa de 60 dias antes do prazo;
- o **primeiro aviso** sai quando o estado é visto pela primeira vez (nenhum aviso anterior para aquele horário: `lastSentAt` nulo), no instante da cadeia mais recente até agora; se a cadeia ainda não começou, o instante registrado é **agora truncado à hora** (um instante futuro da cadeia nunca é reivindicado antes da hora, para não bloquear o aviso das 6 h);
- o **episódio** é o **horário da clínica** (`nextSlot`), não o dia do prazo: se o prazo estimado desloca um dia útil (por exemplo, o calendário publicado passa a cobrir o período), os instantes da cadeia deslocam e pode sair um aviso a mais, mas nunca um episódio novo;
- **só o mais recente devido**: depois de uma queda ou do silêncio, se vários instantes ficaram para trás, sai um aviso só (o mais recente). Os mais antigos são gravados como suprimidos (`suppressed`) **somente depois** de um envio de verdade (ou duplicata), para um envio que falhou não apagar o histórico.

**① sem horário conhecido da clínica** (sem paciente e sem prazo): um aviso a cada 36 h desde o último enviado, sem citar prazo. O primeiro sai na hora; o que cair no silêncio vale as 7h seguintes.

**"Prazo perdido"** (aviso final). Sai quando **todas** as condições valem:

- a disciplina ainda está em ① ou ②;
- o horário anterior da clínica teve o prazo estimado vencido há no máximo 72 h (depois disso nunca sai um aviso velho);
- a pessoa **não marcou nenhuma sessão válida** entre aquele prazo e agora (início ou remarcação dentro de [prazo, agora]; vale qualquer sessão da disciplina que não esteja cancelada nem "não agendada"; **"Falta paciente" conta como marcada**);
- a pessoa **foi avisada naquele episódio** (há um aviso enviado para aquele horário da clínica);
- a **cópia foi sincronizada depois do prazo** (uma marcação de última hora ainda não teria aparecido); enquanto isso, nem o "perdido" nem o primeiro aviso do horário seguinte saem.

Na rodada em que o "perdido" sai, o primeiro aviso do horário seguinte **só é anotado** (já enviado, `suppressed` falso), sem push: o texto do "perdido" já anuncia a próxima chance. Todos os avisos de uma disciplina usam a mesma `tag`, então o novo substitui o anterior no aparelho.

**Reconexão** (por pessoa, não por disciplina). Avisa que o acesso ao SIASB vence **7, 3 e 1 dia antes**, no **instante do vencimento** e depois **a cada 36 h** desde ele. Também vale depois de vencido (por isso o provedor lê contas SIASB em qualquer estado). Só o mais recente devido sai; os anteriores viram suprimidos depois de um envio, e só se já houve um aviso de reconexão antes. Se o acesso já **quebrou** (última tentativa da cópia `RECONNECT_REQUIRED` ou conta em `REAUTH_NEEDED`), vale como vencido desde a **última tentativa da cópia** (`min(vencimento, lastAttemptAt)`, estável nesse estado), e o aviso de "venceu" segue a cadência de 36 h; sem linha de estado não há âncora e vale o vencimento declarado.

### Silêncio, confiança na cópia e quem roda

- **Silêncio 22h-7h (Bahia, UTC-3 fixo).** É regra **só do SIASB**: o `Notifier` genérico é neutro quanto a horário (api#52) e envia a qualquer hora. `SiasbAlerts.evaluateUser` consulta `inQuietHours(now)` (`src/domain/notifications/quiet-hours.ts`) antes de qualquer `Notifier.send` ou `Notifier.record`: dentro do silêncio **nada é enviado nem registrado**; o que está devido continua devido e sai na rodada de 15 minutos seguinte ao fim do silêncio.
- **A cópia só é confiável** se `syncedAt` não é nulo, a última tentativa **não** é `RECONNECT_REQUIRED` e o último sucesso tem **no máximo 24 h**. Fora disso, os avisos de prazo esperam (o de reconexão não depende da cópia). A migração que acrescentou `siasb_attendances.active` zera `last_success_at` e `next_run_at`: depois dela os avisos de prazo esperam a próxima sincronização (até cerca de 30 minutos).
- **Quem roda.** O `notify-cron` (a cada 15 minutos) percorre a lista `ALERT_PROVIDERS` (`src/mcp-wiring.ts`); o `SiasbAlertProvider` (`key` `siasb`) lista as pessoas com conta SIASB em qualquer estado e chama `SiasbAlerts.evaluateUser`. Sem aparelho cadastrado a pessoa é pulada. Nunca lança: erro vira falha contada, sem registrar mensagem.
- **Controle:** o interruptor genérico `siasb.alerts` ("Avisos do SIASB", **ligado** por padrão; `GET`/`PUT /me/notification-settings`).

### Textos (título sempre `SIASB`; `url` `/`)

Datas na Bahia, `sexta, 20/11, às 10h` (ou `às 10h30`); o dia da semana do "clínica de ..." vem do próximo horário (`segunda`, `terça`, `quarta`, `quinta`, `sexta`...).

| Aviso | Texto |
|---|---|
| ② sem sessão | `Você tem paciente em <disciplina>, mas a clínica de <dia> ainda está sem sessão. Prazo estimado: <dia, dd/mm, às Hh>.` |
| ① com prazo | `Você ainda não tem paciente em <disciplina>, e a clínica de <dia> está sem sessão. Cadastre ou pegue um paciente e marque até <dia, dd/mm, às Hh> (prazo estimado).` |
| ① sem horário | `Você ainda não tem paciente nem sessão marcada em <disciplina>. Confira os horários no SIASB.` |
| prazo perdido | `Prazo perdido em <disciplina>.` e, se houver prazo seguinte, ` Próxima chance: <dia, dd/mm, às Hh>.` |
| reconexão (antes) | `Seu acesso ao SIASB vence em <n> dia(s). Reconecte no painel.` |
| reconexão (vencido) | `Seu acesso ao SIASB venceu. Reconecte no painel.` |

### Privacidade

Nenhum título, texto, `tag` ou `subject` leva nome ou iniciais de paciente. O **único dado do SIASB** nos textos é o **nome da disciplina** e os **horários estimados**. Os `subject` (parte da chave anti-duplicata) são `disc:<disciplineId>:<instante do horário da clínica em ISO UTC>` (separa um episódio do seguinte), `disc:<disciplineId>:unscheduled` e `connection`. A `tag` é `siasb-disc:<disciplineId>` para todo aviso de uma disciplina (o novo substitui o anterior) e `siasb-connection` para a reconexão.

### Limites conhecidos

- O prazo é **estimado** (horas úteis, feriados quando há calendário; sem calendário entra 1 dia útil de margem). Pode errar para mais ou para menos; os textos dizem "estimado".
- Uma sessão de **outro horário semanal da mesma disciplina** depois do prazo perdido conta como marcada e **suprime** o "prazo perdido": o erro cai para o lado de avisar menos.
- Se o prazo estimado desloca (por exemplo, `known` do calendário muda), o episódio continua o mesmo (o `subject` é o horário da clínica), mas os instantes da cadeia deslocam e pode sair **um aviso a mais**.
- Uma **sessão cancelada pela clínica** dentro de [prazo, agora] **não conta** como marcada: a pessoa pode receber "prazo perdido" mesmo tendo marcado a tempo.
- O silêncio é decidido **só** pelo serviço de avisos do SIASB, antes de chamar o `Notifier`. Se outra fonte quiser o mesmo silêncio, ela mesma precisa checar `inQuietHours`; o canal genérico não o faz.
- Os avisos só chegam a quem tem **aparelho registrado** pelo canal genérico (`/me/push-devices`); sem aparelho, nada é enviado.
- Não existe ainda rota que mostre ao painel a situação e o prazo por disciplina (`SiasbCopyReader.situation` é interno); a faixa fixa de "prazo aberto" depende dessa rota (ver `handoffs/siasb-avisos-telas.md`, fora do repositório).

## 12. O que NÃO está nesta fase

- **Google Agenda** e **escrita** (agendar e desmarcar): ficam para as fases 3 e 4 do spec (seções 5.6 e 5.7). Nada aqui grava no SIASB. Os avisos por push estão na seção 11.

## 13. Pendências (spec, seção 6)

Nenhuma delas exige requisição ao SIASB sem OK do André.

- **`AcademicCalendar`** agora lê os calendários SUPAC publicados; sem cobertura do período o prazo mantém 1 dia útil de margem.
- **Códigos de situação** das sessões além de 1 e 2 (Atendido, Desmarcado, Cancelada, Nova, Agendado pelo sistema, Falta): hoje o mapeamento é por rótulo.
- **DevTools:** conferir horas úteis, horário de funcionamento e datas bloqueadas do prazo real.
- **Cookie a partir do Railway:** confirmar que o cookie funciona do IP de produção.
- Ainda abertas: se `schedule/sessions` aceita intervalo maior que ~59 dias (afeta `clinica_progresso`), grade de aula da turma, formato de `requests` e `dashboard`.
