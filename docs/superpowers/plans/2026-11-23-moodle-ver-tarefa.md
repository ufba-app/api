# `ver_tarefa` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tool MCP de leitura `ver_tarefa(cursoId, tarefaId)` com estado da entrega, nota e feedback do professor (Moodle).

**Architecture:** `MoodleLive.verTarefa` reaproveita a busca cmid→assign e a leitura de status de `requisitosEntrega` (helper privado) e mapeia `feedback`; a porta `LiveSource.verTarefa?` → `ConsultaService.verTarefa` → `McpUseCases.verTarefa` → tool `ver_tarefa` (leitura, sem permissão de escrita).

**Tech Stack:** NestJS 11, TypeScript, Jest (fake `fetch`, sem rede), Zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-23-moodle-ver-tarefa-design.md`

## Global Constraints

- Camadas `domain` ← `application` ← `interface`; `test/architecture.spec.ts` não pode quebrar.
- Segredo/token/URL/id interno do Moodle nunca em log, erro ou saída; `tarefaId` público = cmid (nunca aceitar o assign id).
- Texto para a pessoa em pt-BR; identificadores em inglês/como já usados no módulo (`estado`, `prazo` já são pt).
- Testes nunca usam rede; AVA real só com OK do André (já usado e encerrado: não chamar de novo).
- Rodar jest com `--runInBand` (focado); suíte completa uma vez: `NODE_OPTIONS=--max-old-space-size=2048 npx jest --maxWorkers=2`. Nunca vários processos pesados ao mesmo tempo.
- Commits terminam com `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Sem push/PR até pedirem.
- Formato real (AVA, 2026-11-23): sem nota, a chave `feedback` não existe e `lastattempt.graded=false`/`gradingstatus="notgraded"`; avaliada: `feedback.gradefordisplay="100,00&nbsp;/&nbsp;100,00"` (HTML), `feedback.grade.grade="100.00000"`, `feedback.gradeddate` (segundos), `feedback.plugins[type=comments].editorfields[name=comments].text="<p>Excelente trabalho.</p>"`, plugin `editpdf` a ignorar.

## Review Focus

- Tarefa entregue sem nota: `avaliacao.avaliada=false`, sem `nota` (nunca `0`) e `comentarios: []`.
- Nota com `&nbsp;`: sai "100,00 / 100,00".
- Avaliada sem comentário do professor: `comentarios: []`.
- Entrega depois do prazo (e com prorrogação `extensionduedate`): `atrasada` correto; sem prazo (`duedate=0`): `false`.
- `tarefaId` que é o assign id (ex. `288097`) ou inválido: "tarefa não encontrada"/id inválido, sem vazar nada.

---

### Task 1: Leitura no `MoodleLive` e porta

**Files:**
- Modify: `src/application/ports/live-source.ts` (junto de `RequisitosEntrega`, ~l.111, e de `requisitosEntrega?`, ~l.217)
- Modify: `src/infrastructure/sources/moodle/moodle-live.ts` (`MoodleSubmissionStatus` l.54; `requisitosEntrega` l.460)
- Test: `src/infrastructure/sources/moodle/moodle-ver-tarefa.spec.ts` (novo; copie o helper `moodle(...)` de `moodle-entrega.spec.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface TarefaVista {
    tarefaId: string;            // cmid público
    titulo: string;
    prazo?: Date;
    estado: 'nova' | 'rascunho' | 'entregue';
    enviadoEm?: Date;            // submission.timemodified (só se há entrega)
    atrasada: boolean;           // enviadoEm > (extensionduedate || duedate); sem prazo/sem entrega = false
    arquivosAtuais: { nome: string; tamanhoBytes: number }[];
    temTextoAtual: boolean;
    avaliacao: { avaliada: boolean; nota?: string; avaliadaEm?: Date; comentarios: string[] };
  }
  // LiveSource:
  verTarefa?(ctx: SourceContext, cursoId: string, cmid: string): Promise<TarefaVista>;
  ```
- `MoodleLive.verTarefa(ctx, cursoId, cmid): Promise<TarefaVista>`.

- [ ] **Step 1: Escrever os testes (falham)** em `moodle-ver-tarefa.spec.ts`, com fake `fetch` e respostas copiadas do formato real acima. Casos, todos via `live.verTarefa(ctx, '359937', '4286503')`:
  - avaliada: `avaliacao` = `{ avaliada: true, nota: '100,00 / 100,00', comentarios: ['Excelente trabalho.'] }`, `avaliadaEm` = `new Date(gradeddate*1000)`, `estado: 'entregue'`, `tarefaId: '4286503'`, `atrasada: false` (`timemodified` antes de `duedate`).
  - entregue sem nota (sem chave `feedback`, `graded:false`): `avaliacao` = `{ avaliada: false, comentarios: [] }`, e `nota` ausente (`not.toHaveProperty('nota')`).
  - avaliada sem comentário (plugin `comments` com `text: ''` ou ausente): `comentarios: []`.
  - atrasada: `timemodified > duedate` → `true`; com `extensionduedate` maior que `timemodified` → `false`; `duedate: 0` → `false`.
  - sem submissão (`lastattempt` sem `submission`): `estado: 'nova'`, `enviadoEm` ausente, `atrasada: false`.
  - id interno (`'288097'`) como `cmid` → rejeita com `SourceError` "tarefa não encontrada neste curso"; `'abc'` → `SourceError` `UNSUPPORTED_SCOPE` "tarefaId inválido".
  - chamadas: exatamente `mod_assign_get_assignments` e `mod_assign_get_submission_status` (nesta ordem, 2 chamadas), a segunda com `assignid` interno; nenhuma mensagem de erro contém `SEGREDO123`.
- [ ] **Step 2:** `npx jest src/infrastructure/sources/moodle/moodle-ver-tarefa.spec.ts --runInBand` → FAIL (`verTarefa` não existe).
- [ ] **Step 3:** Em `moodle-live.ts`: estender `MoodleSubmissionStatus` com `feedback?` (`gradefordisplay`, `gradeddate`, `plugins[].type/editorfields[].name/text`), `lastattempt.graded`, `lastattempt.extensionduedate`, `submission.timemodified`; extrair de `requisitosEntrega` um método privado `lerTarefaEStatus(m, cursoId, cmid)` que devolve `{ a, status }` (validação de ids, busca por cmid, `get_submission_status`) e usá-lo nos dois; implementar `verTarefa` com `this.run(ctx, ...)`. `nota` = `htmlToText(gradefordisplay)` (troca `&nbsp;` por espaço; normalize espaços); `comentarios` = textos do plugin `comments` do `feedback` por `htmlToText`, descartando vazios; `avaliada` = `lastattempt.graded === true`. Nada de `grade.grader`, ids ou `userid` na saída. Adicionar `TarefaVista` e `verTarefa?` em `live-source.ts`.
- [ ] **Step 4:** Rodar o spec novo e `moodle-entrega.spec.ts` (`--runInBand`) → PASS (o refactor não muda `requisitosEntrega`).
- [ ] **Step 5: Commit** `feat(moodle): leitura do estado, nota e feedback de uma tarefa` (adicionar também o design e este plano).

### Task 2: `ConsultaService.verTarefa` e caso de uso MCP

**Files:**
- Modify: `src/application/live/consulta.service.ts` (após `requisitosEntrega`, ~l.195)
- Modify: `src/interface/mcp/mcp-ports.ts` (`McpUseCases`, ~l.180; input `VerTarefaInput { conta?: string; cursoId: string; tarefaId: string }`, perto de `PrepararEnvioInput` l.145)
- Modify: `src/interface/mcp/mcp-use-cases.ts` (`verTarefa`)
- Modify: `src/interface/mcp/testing/stub-mcp.ts`
- Test: `src/application/live/consulta.service.spec.ts` (se existir; senão em `mcp-ver-tarefa.spec.ts` novo) e `src/interface/mcp/mcp-ver-tarefa.spec.ts` (novo, no estilo de `mcp-listar-alunos.spec.ts`)

**Interfaces:**
- Consumes: `LiveSource.verTarefa?`/`TarefaVista` (Task 1).
- Produces: `ConsultaService.verTarefa(quem: Quem, conta: string | undefined, cursoId: string, cmid: string): Promise<TarefaVista>`; `McpUseCases.verTarefa(p: McpPrincipal, i: VerTarefaInput): Promise<unknown>` devolvendo o `TarefaVista` sem alterar campos (já só traz o cmid como `tarefaId`).

- [ ] **Step 1: Testes (falham):** `ConsultaService.verTarefa` lança `FonteSemLeituraError` quando a fonte Moodle não tem `verTarefa` e delega com `(ctx, cursoId, cmid)` quando tem; o caso de uso repassa `i.conta/cursoId/tarefaId` e devolve o resultado (mock de `ConsultaService`, como em `mcp-listar-alunos.spec.ts`).
- [ ] **Step 2:** rodar os specs (`--runInBand`) → FAIL.
- [ ] **Step 3:** Implementar `verTarefa` no serviço (mesmo padrão e mensagem de `requisitosEntrega`: `'Moodle: leitura de tarefa ainda não disponível'`), no caso de uso (`this.consulta.verTarefa(quem(p), i.conta, i.cursoId, i.tarefaId)`), assinatura em `McpUseCases` e `async verTarefa()` no stub devolvendo `{ estado: 'nova' }`-like mínimo (`{ tarefaId: '1', avaliacao: { avaliada: false, comentarios: [] } }`).
- [ ] **Step 4:** specs → PASS; `npx tsc --noEmit -p tsconfig.json` limpo.
- [ ] **Step 5: Commit** `feat(mcp): caso de uso ver_tarefa`.

### Task 3: Tool `ver_tarefa`, docs e verificação final

**Files:**
- Modify: `src/interface/mcp/mcp-tools.ts` (`FERRAMENTAS` l.~52: acrescentar `'ver_tarefa'` após `'ver_curso'`; registrar a tool junto das de leitura, perto de `ver_curso`/`ver_aviso`, fora de `registerEntregaTools`)
- Modify: `docs/MCP.md` (tabela de ferramentas, linha nova; nota em `preparar_envio_tarefa`: continua sendo o passo de escrita), `docs/MOODLE.md` (seção de entrega/leitura: formato do `feedback`, 2 chamadas; "Pendências": tirar `state de entrega` da leitura)
- Test: `src/interface/mcp/mcp-ver-tarefa.spec.ts` (acrescentar)

**Interfaces:**
- Consumes: `McpUseCases.verTarefa`, `VerTarefaInput` (Task 2). Reusar o objeto `TAREFA` de input (`conta`, `cursoId`, `tarefaId` com a descrição do cmid).
- Produces: tool `ver_tarefa` (`readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`), sempre registrada para quem tem Moodle (sem `registerPermissionedTool`).

- [ ] **Step 1: Testes (falham):** `FERRAMENTAS` contém `'ver_tarefa'`; `buildMcpServer` com principal **sem** permissões lista `ver_tarefa` (e continua sem `enviar_tarefa`/`preparar_envio_tarefa`); chamar a tool com stub devolve conteúdo e `readOnlyHint === true`; erro da fonte vira a resposta de erro padrão do `run` (sem vazar token).
- [ ] **Step 2:** `npx jest src/interface/mcp test/mcp-integration.spec.ts test/memory-proxy.spec.ts --runInBand` → FAIL (nova tool ausente); os testes derivados de `FERRAMENTAS.length` passam sozinhos após o registro.
- [ ] **Step 3:** Registrar a tool. Descrição (pt-BR, `+ AO_VIVO`): lê UMA tarefa do AVA: se foi entregue (`estado`), quando (`enviadoEm`) e se atrasou, arquivos atuais, e a **nota e os comentários do professor** (`avaliacao`; sem nota ainda = `avaliada: false`). Use para "foi entregue?", "qual minha nota?", "o que o professor comentou?". `tarefaId` = id da atividade `tipo: tarefa` em `ver_curso`. Para entregar, `preparar_envio_tarefa` (exige permissão de escrita). Atualizar `docs/MCP.md` (2 chamadas Moodle; Classroom/SIGAA: não existe) e `docs/MOODLE.md`.
- [ ] **Step 4: Verificação (uma por vez):** `npx jest <specs acima> --runInBand`; `npx tsc --noEmit -p tsconfig.json`; `npm run build`; suíte completa uma vez: `NODE_OPTIONS=--max-old-space-size=2048 npx jest --maxWorkers=2`. Esperado: tudo verde. `openapi.json` não muda (MCP fora do contrato).
- [ ] **Step 5: Commit** `feat(mcp): ferramenta ver_tarefa (estado, nota e feedback)`. Sem push/PR até pedirem.
