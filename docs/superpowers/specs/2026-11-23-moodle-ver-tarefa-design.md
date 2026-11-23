# `ver_tarefa`: estado da entrega, nota e feedback (Moodle) — design curto

## Intenção
Hoje nenhuma tool de leitura mostra se a tarefa foi entregue, a nota ou o comentário do professor. O estado só aparece em
`preparar_envio_tarefa`, que exige `moodle.assignment_write`. Caso real: "Avaliação 01" (Enviado, Avaliado, 100,00/100,00,
"Excelente trabalho.") e o assistente não soube responder "qual foi minha nota?".

## Decisões (André, 2026-11-23)
- Tool nova **`ver_tarefa(cursoId, tarefaId)`**, só leitura, **sem** permissão de escrita (são dados do próprio aluno).
- **Nota só dentro de `ver_tarefa`.** Nada de `notas(cursoId)` agora (`gradereport_user_get_grade_items` dá 504 em alguns cursos);
  fica como follow-up (quizzes e total do curso).
- `preparar_envio_tarefa` continua: é o passo de escrita (regras da entrega + `linkUpload`).
- `ver_curso`/`prazos` não mudam (sem custo extra por tarefa).

## Não-objetivos
Grades do curso inteiro; tool de escrita; mudar `preparar_envio_tarefa`; texto online do aluno (só `temTextoAtual`, como hoje).

## Abordagens consideradas
1. **Tool nova por tarefa (escolhida):** 2 chamadas Moodle (`mod_assign_get_assignments` + `mod_assign_get_submission_status`), só sob demanda.
2. Campo `entrega` em todas as tarefas de `ver_curso`: +1 chamada por tarefa (~10 por curso), piora quem só lista.
3. Os dois: mais código e chamadas sem necessidade comprovada.

## Desenho
- **Id:** `tarefaId` público = `cmid` de `ver_curso`; resolvido para o assign id internamente (reuso de `requisitosEntrega`).
  Nunca aceitar o id interno.
- **Moodle (`MoodleLive`):** extrair do `requisitosEntrega` o trecho "acha a tarefa pelo cmid + lê o status" para um helper
  privado e usar nos dois; novo `verTarefa` mapeia a resposta. `MoodleSubmissionStatus` ganha `feedback`
  (`gradefordisplay`, `grade.grade`/`grade.grader`/`gradeddate`, plugin `comments` → `editorfields[].text`) e
  `submission.timemodified`, `gradingstatus`.
- **Porta:** `LiveSource.verTarefa?(ctx, cursoId, cmid): Promise<TarefaVista>`, opcional como `requisitosEntrega`.
- **`TarefaVista`:** `tarefaId`(cmid), `titulo`, `prazo?`, `estado` (`nova|rascunho|entregue`), `enviadoEm?`, `atrasada` (envio depois do
  prazo), `arquivosAtuais[]`, `temTextoAtual`, `avaliacao`: `{ avaliada: boolean, nota?: string (texto do Moodle, ex. "100,00 / 100,00"),
  avaliadaEm?, comentarios: string[] }`. Comentários passam por `htmlToText`. Ausente = sem nota ainda, nunca `0`.
- **Aplicação:** `ConsultaService.verTarefa` (como `requisitosEntrega`: `FonteSemLeituraError` se a fonte não implementa).
- **MCP:** use case + `ver_tarefa` em `mcp-tools.ts` (readOnly, idempotente, fora do grupo de escrita), `mcp-ports.ts`, `stub-mcp.ts`.
  Descrição em pt-BR; aponta `preparar_envio_tarefa` para quem quer entregar.
- **Segurança:** nada de token, URL ou id interno em log/erro/saída; erros pelo `SourceError` existente.
- **Testes (fake `fetch`, sem rede):** nova/rascunho/entregue; avaliada com nota e comentário; entregue sem avaliação; atrasada; cmid
  inexistente; id inválido; fonte sem suporte. Docs: `docs/MCP.md`, `docs/MOODLE.md` (e tirar o `state` de "Pendências").

## Formato real confirmado (AVA, só leitura, 2026-11-23)
- Sem nota: **não existe a chave `feedback`**; `lastattempt.graded=false`, `gradingstatus="notgraded"`.
- Avaliada: `lastattempt.graded=true`, `gradingstatus="graded"`; `feedback.gradefordisplay` = `"100,00&nbsp;/&nbsp;100,00"`
  (**tem entidade HTML**: passar por `htmlToText`), `feedback.grade.grade` = `"100.00000"` (string), `feedback.gradeddate` (segundos),
  `feedback.plugins[type=comments].editorfields[name=comments].text` = `"<p>Excelente trabalho.</p>"` (HTML).
  O plugin `editpdf` também aparece (ignorar).
- `lastattempt.submission.timemodified` em segundos; o plugin `comments` da submissão é do aluno (não é o feedback do professor).
- Atrasada: `timemodified > (extensionduedate || duedate)` quando há prazo.

## Deixado ao construtor
Detalhes de nomes internos e organização dos testes.
