# Frequência do SIGAA (mapa de frequência por turma)

Rascunho para aprovação do André. Mudança pequena: um parser, um método em `SigaaLive`, uma rota.

## Por quê

A tela "Notas e faltas" do painel (artifact de design, seção 27, `Nf_pagina`) mostra, por disciplina, as faltas contra o limite
de 25% e a situação ("Em dia", "No limite"). Esta etapa traz só a frequência, só do SIGAA. As notas ficam para depois.

## O que o spike mostrou (turma real, só leitura, em 16/11/2026)

- `GET /sigaa/ava/FrequenciaAluno/mapa.jsf` **não funciona direto**, nem depois de entrar na turma: "Comportamento Inesperado!".
  A página só abre pelo clique em **Frequência** (grupo "Alunos") no `form#formMenu` da turma, que é um postback JSF
  (`jsfcljs(formMenu, {'formMenu:j_id_…': 'formMenu:j_id_…'})`, action `/sigaa/ava/index.jsf`); no navegador a URL passa a `mapa.jsf`. Não foi medido se a resposta ao POST é 302 ou 200 com o conteúdo; o código aceita os dois (ver `SigaaSession.postback`).
  O nome do `j_id_…` muda por deploy: sempre ler do HTML, achando o link pelo texto "Frequência".
- Conteúdo da página (`fieldset` "Mapa de Frequências"), tudo em **aulas** (uma aula = 55 min), não em horas:
  - Presenças Registradas
  - Número de Aulas com Registro de Frequência
  - Porcentagem de Frequência em relação às Aulas com Registro
  - Número de Aulas definidas pela CH do Componente
  - Porcentagem de Frequência em relação à CH
  - Aviso vermelho "A frequência ainda não foi lançada." (apareceu com 29 de 32 aulas registradas; o significado exato não está claro)
- A página **não traz faltas**. Falta = aulas registradas − presenças.
- Regra do SIGAA: aprovado por assiduidade com 75% da CH **ou** 75% das aulas ministradas (se o professor lançou 90%).
  O limite de 25% do André corresponde à primeira regra; é a que usamos.

## Metas

- `GET /sources/sigaa/attendance`: frequência da turma de cada disciplina do semestre, lida ao vivo, nada gravado.
- A conta do risco fica no backend, para o painel e o MCP usarem a mesma regra.

## Fora do escopo

Notas; "faltam N encontros até o fim do semestre" (precisa de horário e calendário); outras fontes (Moodle, Classroom);
histórico de semestres anteriores.

## Abordagens

1. **Postback do menu por turma, como `verCurso`/`prazos` (escolhida).** Portal → entrar na turma → postback do item
   "Frequência" → parser. Segue o caminho que o SIGAA aceita e reaproveita `entrarNaTurma`. O `SigaaSession.postback` passou a seguir um 302 para dentro de `/sigaa/` com GET (antes devolvia o corpo vazio do 302).
   Custo: o portal uma vez, mais 2 requisições por turma (entrar na turma e postback do menu).
2. **GET direto em `mapa.jsf`.** Descartada: falha no SIGAA real.
3. **Ler o resumo de frequência do histórico/PDF.** Descartada: o histórico não tem frequência do semestre em curso.

## Design

- **Parser** `turma-virtual/frequencia.ts`, mesma disciplina de `avaliacoes.ts` (`assertPaginaDaTurmaVirtual`, erro alto se a
  página não for reconhecida, nunca lista vazia no lugar de "não deu para ler"):
  - `parsePostbackFrequencia(turmaHtml)`: acha o `<a>` do menu cujo `.itemMenu` é "Frequência", lê o `jsfcljs`, devolve
    `{ action, fields }` com os hidden do `formMenu` (sem `javax.faces.ViewState`, que a sessão manda).
  - `parseFrequencia(html)`: lê os cinco números e o aviso "ainda não foi lançada".
- **`SigaaLive.frequencia(ctx)`** (fora da porta `LiveSource`, por ser só do SIGAA, como `verAviso?`; vira método opcional da porta):
  portal uma vez, depois por turma entrar + postback do menu, no máximo `MAX_TURMAS_PRAZOS` turmas. Mesmo risco não validado
  de `prazos` (ViewState da última página da sessão na 2ª turma em diante); falha alto com `UNAVAILABLE`.
- **Conta (minhas decisões, corrija se estiverem erradas):**
  - `absentClasses = max(recordedClasses − presentClasses, 0)`
  - `allowedAbsentClasses = floor(0.25 × workloadClasses)`
  - `remainingAbsentClasses = allowedAbsentClasses − absentClasses` (pode ser negativo; o painel mostra 0)
  - `status`: `failed` se `absentClasses > allowedAbsentClasses`; `at_risk` se restam `≤ 1/3` do limite; senão `ok`.
    O 1/3 é palpite meu, calibrado pelo mock (5 de 17 = "No limite", 13 de 17 = "Em dia").
  - `complete = false` quando o aviso "ainda não foi lançada" aparece (suposição minha sobre o significado do aviso, não
    confirmada pelo André). Nesse caso o status é calculado com o que há e o
    painel deve tratar como estimativa: as aulas que ainda não foram lançadas podem virar falta.
- **Resposta**, por disciplina: `courseId`, `courseName`, `presentClasses`, `recordedClasses`, `workloadClasses`,
  `absentClasses`, `allowedAbsentClasses`, `remainingAbsentClasses`, `status`, `complete`; mais `summary`:
  `absentClasses`, `allowedAbsentClasses`, `atRiskCourses`. Sem código da disciplina (ex.: ODON24): a página e o token da
  turma não trazem; hoje só há o nome.
- **Contrato:** rota, schema e `status` no `contract.ts`, entrada em `ROUTES` do `openapi.ts`, `npm run openapi`,
  commit do `openapi.json` e aviso ao Mosaico (o mock usa "h"; a unidade real é aula).
- **Testes:** fixtures sanitizados (sem nome nem CPF) da página da turma (menu) e da `mapa.jsf`, uma turma com faltas e uma
  sem; testes sem rede, no estilo de `avaliacoes.spec.ts`.

## Para o construtor decidir

Nome exato dos campos e do enum em inglês; mensagem de erro em pt-BR; se `summary` também vai no MCP depois.
