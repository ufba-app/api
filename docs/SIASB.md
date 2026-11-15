# SIASB (clínicas)

O SIASB é o sistema das clínicas-escola da UFBA. A integração deixa a pessoa, pelo Claude, ver a situação nas disciplinas de clínica, as sessões, os pacientes em atendimento e o **prazo estimado** para marcar paciente. É **só leitura** e **ao vivo**: cada pergunta vai ao SIASB na hora, com a conexão que a pessoa fez, e nada do conteúdo é copiado para o banco.

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

- **Só iniciais** do paciente, mais disciplina, tipo de tratamento, horário, local e professor. Nome completo, prontuário e qualquer registro clínico **não passam** pelo mapeador.
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
- **Margem.** Os feriados vêm da porta `AcademicCalendar` (`src/application/ports/academic-calendar.ts`). A implementação atual é `NoAcademicCalendar` (`known: false`, sem datas): **enquanto não houver calendário oficial, soma-se 1 dia útil de margem** (o erro cai para o lado de o aluno chegar cedo) e a resposta traz `feriadosConsiderados: false` com o aviso "Feriados e recessos não considerados; confirme o prazo no SIASB."
- O horário de cada clínica é **deduzido do histórico** de sessões da disciplina (janela de 60 dias para trás). Sem histórico, não há horário nem prazo. Se o prazo do próximo horário já passou, vale o da semana seguinte.

## 7. Ferramentas MCP

As 7 ferramentas (`src/interface/mcp/clinica-tools.ts`). **Visibilidade:** aparecem para a pessoa que tem conexão SIASB **em qualquer estado** (conectada ou a reconectar); sem conexão, não existem na lista. A decisão é por requisição e, se falhar ao resolver, vale "não mostrar" (nunca derruba o MCP).

| Ferramenta | Entrada | Devolve | Chamadas ao SIASB (máx.) |
|---|---|---|---|
| `clinica_situacao` | nenhuma | por disciplina: `estado`, `proximaClinica`, `prazoEstimado` (`null` em `sessao_marcada`), `feriadosConsiderados` | 3 (disciplinas, atendimentos ativos, sessões) |
| `clinica_sessoes` | `de?`, `ate?` (ISO; padrão: próximos 14 dias; até 45 dias à frente) | sessões: disciplina, início, fim, local, professor, iniciais, situação, `reagendamentoPara` | 1 |
| `clinica_prazo_marcacao` | exatamente um: `disciplinaId` ou `inicioSessao` | `prazoEstimado`, `feriadosConsiderados` | 1 com `disciplinaId`; 0 com `inicioSessao` |
| `clinica_pacientes` | nenhuma | atendimentos ativos por disciplina: `atendimentoId`, `iniciais`, `tipo` (`triagem`, `planejamento`, `urgencia`, `desconhecido`) | 2 |
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

Uma só consulta de sessões cobre do início do período até o maior entre o fim e agora + 45 dias (para contar as marcadas adiante). A lista de atendimentos não traz data de conclusão: "concluídos no período" = concluído com alguma sessão no período; "no histórico" = todos os concluídos.

**Ritmo (semântica).** Calculado só sobre a parte **decorrida** do período, `[início, min(fim, agora)]`. As semanas são **blocos de 7 dias a partir do início do período** (não semanas de calendário). Só blocos completos podem ser "semana sem sessão": o último bloco, parcial, e blocos que começam depois de agora nunca contam. `sessoesPorSemana` = sessões atendidas ou marcadas ÷ semanas decorridas, e é `null` com menos de 1 dia decorrido. Período que ainda não começou: ritmo não calculado e aviso próprio. `horariosHabituais` vêm dos horários deduzidos do histórico.

## 8. Fuso

Os horários do SIASB são **horário da Bahia, UTC-3 fixo** (sem horário de verão). Na entrada e na saída o servidor converte (`src/domain/siasb/time.ts`); a API devolve ISO com offset `-03:00`. Datas sem hora, nas ferramentas, valem a hora da Bahia (`ate` = fim do dia).

## 9. Web: rotas e erros

Detalhes em `docs/WEB-API.md`.

| Rota | Resposta |
|---|---|
| `POST /connections/siasb { "password": "string" }` | 204 |
| `DELETE /connections/siasb` | 204 (mantém o vínculo) |
| `GET /me` → `connections.siasb { offered, status, expiresAt }` | `status`: `connected`, `reconnect_required` ou `disconnected` |

Erros da conexão:

| Status | `error` | Quando |
|---|---|---|
| 400 | `invalid_request` | corpo inválido, ou a pessoa não tem matrícula (a vida acadêmica precisa estar importada) |
| 409 | `source_account_mismatch` | a conta do SIASB não é a da matrícula (ou a conta já está ligada a outra matrícula) |
| 409 | `source_account_taken` | essa matrícula já está ligada a outra conta do ufba.app |
| 422 | `siasb_credentials_rejected` | o SIASB recusou a matrícula ou a senha |
| 422 | `siasb_password_migration_required` | a pessoa precisa entrar uma vez no SIASB para atualizar a senha |
| 503 | `siasb_unavailable` | o SIASB não respondeu (fora do ar, 429, página inesperada) |

## 10. O que NÃO está nesta fase

- **Alertas por push**, **Google Agenda** e **escrita** (agendar e desmarcar): ficam para as fases 2, 3 e 4 do spec (seções 5.4, 5.6 e 5.7). Nada aqui grava no SIASB.
- Ciclo em segundo plano e agendador (a trava por pessoa do jar vem com ele).

## 11. Pendências (spec, seção 6)

Nenhuma delas exige requisição ao SIASB sem OK do André.

- **`AcademicCalendar` oficial** (a cargo do André). Até lá o prazo usa 1 dia útil de margem.
- **Códigos de situação** das sessões além de 1 e 2 (Atendido, Desmarcado, Cancelada, Nova, Agendado pelo sistema, Falta): hoje o mapeamento é por rótulo.
- **DevTools:** conferir horas úteis, horário de funcionamento e datas bloqueadas do prazo real.
- **Cookie a partir do Railway:** confirmar que o cookie funciona do IP de produção.
- Ainda abertas: se `schedule/sessions` aceita intervalo maior que ~59 dias (afeta `clinica_progresso`), grade de aula da turma, formato de `requests` e `dashboard`.
