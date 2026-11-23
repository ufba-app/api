# Envio de tarefas no Moodle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O aluno entrega tarefa do AVA (arquivo e/ou texto) por três ferramentas MCP finas sobre um caso de uso reutilizável pela REST.

**Architecture:** `MoodleLive` ganha quatro métodos opcionais da porta `LiveSource` (requisitos, upload para o rascunho do Moodle, salvar, finalizar). Um `EntregaService` (camada `application`) valida as regras, guarda em memória links de upload e confirmações de uso único e escolhe salvar ou entregar. O MCP e um `UploadController` (`POST /upload/:id`) só adaptam.

**Tech Stack:** NestJS 11, TypeScript, Jest 30 (sem rede, `fetch` simulado), Zod v4, MCP SDK, multer (já vem com `@nestjs/platform-express`).

**Spec:** `docs/specs/2026-11-22-moodle-envio-tarefas.md`

## Global Constraints

- Branch `feat/moodle-envio-tarefas` (e as seguintes empilhadas); **commit só em branch; sem push, PR ou merge sem o André pedir**. Commits terminam com a linha `Co-Authored-By` indicada pelo ambiente.
- `claude.prMaxLines=0` neste repo; mesmo assim, 3 PRs em sequência (Tasks 1-3, 4-6, 7-8), cada um com build, testes e `tsc` verdes.
- Antes de dizer "pronto": `npm run build`, `npm test`, `npx tsc --noEmit -p tsconfig.json`. Mudou o contrato Zod: `npm run openapi` e commitar `openapi.json`.
- Testes nunca usam rede nem dados reais do AVA; **nenhum teste contra o AVA real** (a validação real é do André, com a ED2 e a ED3, depois).
- Camadas `domain` ← `application` ← `interface`; `test/architecture.spec.ts` quebra o build se violada. Identificadores em inglês só onde o código já usa inglês; o módulo de leitura ao vivo usa português (`postarForum`, `ConsultaService`): seguir o padrão do arquivo. Textos para a pessoa em pt-BR.
- Segredos: o token circula como `Secret`; nunca em log, erro ou resposta. Conteúdo do trabalho nunca em log nem no banco.
- Permissão `moodle.assignment_write`, risco `high`; sem ela as três ferramentas nem aparecem em `tools/list` (`registerPermissionedTool`).
- TTL: link de upload 15 min, confirmação 10 min; ambos de uso único e só em memória. Base64 inline: no máximo 2 MB somando tudo.
- v1 recusa tarefa em grupo (`teamsubmission=1`) e com declaração de autoria (`requiresubmissionstatement=1`). Salvar arquivos **substitui** o conjunto de arquivos da entrega.

## Review Focus

- Nome de arquivo com `..`, `/`, controle ou mais de 255 caracteres: é saneado antes de ir ao Moodle (Task 2).
- Tarefa `entregue` com `podeEditar=false`: recusa sem escrever; `entregue` com `podeEditar=true`: o resumo diz que substitui (Task 5).
- `confirmacaoId` de outra pessoa, expirado, reutilizado ou de outra ação: recusa e nada é escrito (Tasks 4 e 5).
- Arquivo fora da extensão, do tamanho ou da quantidade da tarefa: recusa antes de tocar o Moodle (Task 5).
- `save_submission` que responde com `warnings` não vazio: é falha, não sucesso (Task 3). Texto com `<script>` vai escapado, e texto online só é aceito se a tarefa aceita (Tasks 3 e 5); o `itemid` do texto online **não foi validado no AVA real** (ED1 só aceita arquivo): registrar em `docs/MOODLE.md`.

---

## PR 1: porta e chamadas do Moodle

### Task 1: Tipos da porta e `requisitosEntrega`

**Files:**
- Modify: `src/application/ports/live-source.ts` (tipos e 4 métodos opcionais em `LiveSource`)
- Modify: `src/infrastructure/sources/moodle/moodle-live.ts`
- Test: `src/infrastructure/sources/moodle/moodle-entrega.spec.ts` (novo; helper `moodle(responses)` e `ctx` copiados do molde de `moodle-forum-write.spec.ts`)

**Interfaces:**
- Produces, em `live-source.ts`:
  ```ts
  export interface RequisitosEntrega {
    tarefaId: string; titulo: string;
    aceitaArquivo: boolean; aceitaTexto: boolean;
    maxArquivos?: number; maxBytesPorArquivo?: number; extensoes: string[]; // [] = qualquer
    abreEm?: Date; prazo?: Date; limite?: Date;
    exigeBotaoEnviar: boolean; emGrupo: boolean; exigeDeclaracao: boolean;
    estado: 'nova' | 'rascunho' | 'entregue'; podeEditar: boolean;
    arquivosAtuais: { nome: string; tamanhoBytes: number }[];
  }
  export interface ArquivoParaEnvio { nome: string; bytes: Uint8Array }
  export interface RascunhoEnviado { itemId: string; arquivos: { nome: string; tamanhoBytes: number }[] }
  export interface EntregaTarefa { tarefaId: string; itemId?: string; texto?: string }
  export interface EstadoEntrega { estado: 'nova' | 'rascunho' | 'entregue' }
  // em LiveSource:
  requisitosEntrega?(ctx: SourceContext, cursoId: string, tarefaId: string): Promise<RequisitosEntrega>;
  subirArquivosEntrega?(ctx: SourceContext, arquivos: ArquivoParaEnvio[]): Promise<RascunhoEnviado>;
  salvarEntrega?(ctx: SourceContext, e: EntregaTarefa): Promise<EstadoEntrega>;
  finalizarEntrega?(ctx: SourceContext, tarefaId: string): Promise<EstadoEntrega>;
  ```

- [ ] **Step 1: Write the failing tests** em `moodle-entrega.spec.ts`, `describe('MoodleLive.requisitosEntrega')`:
  - `'lê get_assignments do curso e o status, e mapeia as configs'`: respostas simuladas de `mod_assign_get_assignments` (curso com a tarefa `id:286293`, `name:'ED1'`, `duedate:1796266620`, `cutoffdate:0`, `allowsubmissionsfromdate:0`, `submissiondrafts:0`, `teamsubmission:0`, `requiresubmissionstatement:0`, configs `file.enabled=1`, `file.maxfilesubmissions=20`, `file.maxsubmissionsizebytes=52428800`, `file.filetypeslist=''`, `onlinetext.enabled=0`) e de `mod_assign_get_submission_status` (`lastattempt:{canedit:true, submission:{status:'new', plugins:[]}}`). Asserts: `calls[0].get('courseids[0]')==='359934'`, `calls[1].get('assignid')==='286293'`; resultado `toMatchObject({aceitaArquivo:true, aceitaTexto:false, maxArquivos:20, maxBytesPorArquivo:52428800, extensoes:[], exigeBotaoEnviar:false, estado:'nova', podeEditar:true, limite:undefined, prazo:new Date(1796266620*1000)})`.
  - `'status draft/submitted vira rascunho/entregue e lista os arquivos atuais'`: plugin `file` com `fileareas:[{area:'submission_files', files:[{filename:'a.zip', filesize:10}]}]`.
  - `'extensões: ".pdf, .zip" vira [".pdf",".zip"]'`.
  - `'tarefa que não está no curso: SourceError UNSUPPORTED_SCOPE'`; `'ids que não são inteiros não chegam ao Moodle'` (calls vazio).

- [ ] **Step 2: Run:** `npx jest src/infrastructure/sources/moodle/moodle-entrega.spec.ts` — Expected: FAIL (`requisitosEntrega` não existe).

- [ ] **Step 3: Implement** os tipos acima em `live-source.ts` e `requisitosEntrega` em `MoodleLive` (usa `this.run`, `this.client.call`; timestamps do Moodle são segundos e `0` = ausente; `submissiondrafts===1` ⇒ `exigeBotaoEnviar`; `filetypeslist` separado por vírgula ou espaço, normalizado para minúsculas).

- [ ] **Step 4: Run** o mesmo comando — Expected: PASS.

- [ ] **Step 5: Commit** (`git checkout -b feat/moodle-envio-tarefas` antes, na primeira vez)

```bash
git add src/application/ports/live-source.ts src/infrastructure/sources/moodle/moodle-live.ts src/infrastructure/sources/moodle/moodle-entrega.spec.ts
git commit -m "feat(moodle): requisitos de entrega de tarefa (porta e leitura)"
```

### Task 2: `subirArquivosEntrega` (upload.php)

**Files:**
- Modify: `src/infrastructure/sources/moodle/moodle-live.ts`, `src/infrastructure/sources/moodle/moodle-client.ts`
- Test: `src/infrastructure/sources/moodle/moodle-entrega.spec.ts`

**Interfaces:**
- Consumes: `ArquivoParaEnvio`, `RascunhoEnviado` (Task 1).
- Produces: `MoodleClient.upload(ctx: MoodleAccess, arquivos: { nome: string; bytes: Uint8Array }[]): Promise<{ itemId: string; arquivos: { nome: string; tamanhoBytes: number }[] }>` (um POST multipart a `{baseUrl}/webservice/upload.php` com `token`, `filearea=draft`, `itemid=0`, `file_1..file_n`) e `export function nomeSeguro(nome: string): string` em `moodle-client.ts`.

- [ ] **Step 1: Write the failing tests**, `describe('MoodleLive.subirArquivosEntrega')` (o `fetchFn` simulado devolve `[{filename:'a.zip', filesize:3, itemid:137294331}, ...]` para `/webservice/upload.php`):
  - `'um POST multipart com token, filearea=draft, itemid=0 e file_1'`: a URL termina em `/webservice/upload.php`, `body` é `FormData`, `body.get('token')==='SEGREDO123'`, devolve `{itemId:'137294331', arquivos:[{nome:'a.zip', tamanhoBytes:3}]}`.
  - `'vários arquivos vão no mesmo POST como file_1, file_2'`.
  - `'resposta com exception vira SourceError sem o token'` e `'resposta que não é lista com itemid vira SourceError UNAVAILABLE'`.
  - `describe('nomeSeguro')`: `'../../etc/passwd'`→`'passwd'`; `'a/b\\c.pdf'`→`'c.pdf'`; remove `\r\n\0`; `''`→`'arquivo'`; corta em 255 preservando a extensão.

- [ ] **Step 2: Run** `npx jest src/infrastructure/sources/moodle/moodle-entrega.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `MoodleClient.upload` (mesmo tratamento de erro e `scrub` de `call`; um item de erro tem `error`/`exception`) e `MoodleLive.subirArquivosEntrega` aplicando `nomeSeguro` aos nomes.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(moodle): upload de arquivos para o rascunho (upload.php)"`

### Task 3: `salvarEntrega` e `finalizarEntrega`

**Files:**
- Modify: `src/infrastructure/sources/moodle/moodle-live.ts`
- Test: `src/infrastructure/sources/moodle/moodle-entrega.spec.ts`

**Interfaces:**
- Consumes: `EntregaTarefa`, `EstadoEntrega` (Task 1); `textoParaHtml` (já existe em `moodle-live.ts`).
- Produces: `MoodleLive.salvarEntrega` e `finalizarEntrega` (assinaturas da Task 1).

- [ ] **Step 1: Write the failing tests**, `describe('MoodleLive.salvarEntrega')`:
  - `'com arquivos: save_submission com plugindata[files_filemanager]=itemId'`: `calls` tem `mod_assign_save_submission` com `assignmentid==='286293'` e `plugindata[files_filemanager]==='137294331'`; depois um `mod_assign_get_submission_status`; resultado `{estado:'entregue'}` quando o status volta `submitted`.
  - `'com texto: plugindata[onlinetext_editor][text] em HTML escapado, [format]=1 e [itemid]'`: `'<script>x</script>'` vira `<p>&lt;script&gt;x&lt;/script&gt;</p>`.
  - `'resposta com warnings não vazio é SourceError com a mensagem do Moodle'`.
  - `'id não inteiro não chega ao Moodle'`.
  - `describe('MoodleLive.finalizarEntrega')`: `'chama mod_assign_submit_for_grading com assignmentid e acceptsubmissionstatement=0'` e devolve o estado lido depois; `warnings` não vazio é falha.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** os dois métodos (cada um termina com `mod_assign_get_submission_status` para devolver o `estado`; texto sem `itemId` usa `itemid=0`).

- [ ] **Step 4: Run** — Expected: PASS. Depois `npm run build && npm test && npx tsc --noEmit -p tsconfig.json` (fecha o PR 1).

- [ ] **Step 5: Commit** — `git commit -m "feat(moodle): salvar e finalizar entrega de tarefa"`

---

## PR 2: caso de uso e upload

### Task 4: Links de upload e confirmações (memória)

**Files:**
- Create: `src/application/live/entrega-links.ts`
- Test: `src/application/live/entrega-links.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UploadTicket { userId: string; conta: string; cursoId: string; tarefaId: string; requisitos: RequisitosEntrega; expiresAt: number }
  export interface RascunhoGuardado { userId: string; conta: string; tarefaId: string; itemId: string; arquivos: { nome: string; tamanhoBytes: number }[]; expiresAt: number }
  export class UploadLinks {
    constructor(ttlMs = 15 * 60_000, now: () => number = Date.now);
    abrir(t: Omit<UploadTicket, 'expiresAt'>): { id: string; expiresAt: Date };
    consumir(id: string): UploadTicket | undefined;            // uso único
    guardar(id: string, r: Omit<RascunhoGuardado, 'expiresAt'>): void;
    ler(id: string, userId: string): RascunhoGuardado | undefined; // só o dono
  }
  export interface ConfirmacaoEntrega { userId: string; acao: 'rascunho' | 'enviar'; conta: string; cursoId: string; tarefaId: string; itemId?: string; texto?: string; expiresAt: number }
  export class ConfirmacoesEntrega {
    constructor(ttlMs = 10 * 60_000, now: () => number = Date.now);
    criar(c: Omit<ConfirmacaoEntrega, 'expiresAt'>): { id: string; expiresAt: Date };
    consumir(id: string, userId: string, acao: 'rascunho' | 'enviar'): ConfirmacaoEntrega | undefined;
  }
  ```

- [ ] **Step 1: Write the failing tests** (relógio injetado): `'link: consumir duas vezes, só a primeira devolve'`; `'link expirado some'`; `'ler só devolve para o dono'`; `'confirmação: outra pessoa não consome e a confirmação continua valendo para o dono'`; `'confirmação: ação diferente não consome'`; `'confirmação expirada ou reutilizada devolve undefined'`; ids têm pelo menos 32 caracteres (`randomBytes(24).toString('base64url')`).

- [ ] **Step 2: Run:** `npx jest src/application/live/entrega-links.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** as duas classes no molde de `download-links.ts` (mapa em memória, `limpar()` ao criar).

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(entrega): links de upload e confirmações em memória"`

### Task 5: `EntregaService` e passagens do `ConsultaService`

**Files:**
- Create: `src/application/live/entrega.service.ts`
- Modify: `src/application/live/consulta.service.ts` (4 métodos finos: `requisitosEntrega`, `subirArquivosEntrega`, `salvarEntrega`, `finalizarEntrega`, no molde de `postarForum`: `FonteSemLeituraError` se o Moodle não tem o método, `this.com('MOODLE', ...)`; e `export class EntregaInvalidaError extends Error {}` ao lado de `PostagemInvalidaError`)
- Test: `src/application/live/entrega.service.spec.ts` (fonte Moodle falsa em memória registrada em `LiveSources`; ver como `consulta.service` é montado nos specs existentes de `src/application/live/`)

**Interfaces:**
- Consumes: Task 1 (tipos), Task 4 (`UploadLinks`, `ConfirmacoesEntrega`).
- Produces:
  ```ts
  export interface PedidoEntrega { conta?: string; cursoId: string; tarefaId: string; texto?: string; uploadId?: string; arquivos?: ArquivoParaEnvio[] }
  export interface PreparoEntrega { requisitos: RequisitosEntrega; uploadId?: string; expiraEm?: Date }
  export interface ResumoEntrega { confirmacaoId: string; expiraEm: Date; acao: 'rascunho' | 'enviar'; tarefa: string; arquivos: { nome: string; tamanhoBytes: number }[]; texto?: string; efeito: string; prazo?: Date; atrasada: boolean; substituiEntrega: boolean }
  export interface EntregaFeita { estado: 'nova' | 'rascunho' | 'entregue'; entregue: boolean }
  @Injectable() export class EntregaService {
    constructor(consulta: ConsultaService, uploads: UploadLinks, confirmacoes: ConfirmacoesEntrega, now?: () => number);
    preparar(quem: Quem, i: { conta?: string; cursoId: string; tarefaId: string }): Promise<PreparoEntrega>;
    receberUpload(uploadId: string, arquivos: ArquivoParaEnvio[]): Promise<{ arquivos: { nome: string; tamanhoBytes: number }[] }>;
    solicitar(quem: Quem, acao: 'rascunho' | 'enviar', p: PedidoEntrega): Promise<ResumoEntrega>;
    confirmar(quem: Quem, acao: 'rascunho' | 'enviar', confirmacaoId: string): Promise<EntregaFeita>;
  }
  ```
  `receberUpload` valida contra o `requisitos` do ticket (quantidade, tamanho por arquivo, extensão), envia ao Moodle (`subirArquivosEntrega`) e `guardar`; `solicitar` com `arquivos` inline faz o mesmo caminho (teto de 2 MB somados), com `uploadId` lê o guardado (`ler(uploadId, quem.userId)`). `preparar` abre o link só se `aceitaArquivo`.

- [ ] **Step 1: Write the failing tests**, uma por regra (todas com asserts de que **nenhuma** escrita ocorreu quando recusa: `salvarEntrega`/`finalizarEntrega` não chamados):
  - `'preparar devolve os requisitos e um uploadId; sem aceitaArquivo não há uploadId'`.
  - `'solicitar não escreve: devolve resumo com confirmacaoId, e efeito diz "entrega" quando exigeBotaoEnviar=false'`; com `exigeBotaoEnviar=true`, `acao:'rascunho'` → efeito "salva como rascunho"; `acao:'enviar'` → "entrega".
  - `'rascunho em tarefa sem botão é recusado, mandando usar enviar_tarefa'` (mensagem contém `enviar_tarefa`).
  - `'tarefa em grupo, com declaração, fora da janela (abreEm no futuro, limite no passado), entregue com podeEditar=false: EntregaInvalidaError'`.
  - `'depois do prazo e antes do limite: atrasada=true e segue'`.
  - `'entregue com podeEditar=true: substituiEntrega=true'`.
  - `'arquivo fora da extensão / maior que o limite / além de maxArquivos: recusa antes de subir'` (`subirArquivosEntrega` não chamado).
  - `'texto em tarefa que não aceita texto: recusa'`; `'pedido sem arquivo nem texto: recusa'`; `'base64 acima de 2 MB: recusa'`.
  - `'confirmar enviar: salva e, com exigeBotaoEnviar=true, também finaliza; sem botão só salva (não chama finalizarEntrega)'`; `'confirmar rascunho: só salva'`.
  - `'confirmar com id de outra pessoa, expirado, reutilizado ou de outra ação: EntregaInvalidaError e nada escrito'`.

- [ ] **Step 2: Run:** `npx jest src/application/live/entrega.service.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `EntregaService` e as 4 passagens no `ConsultaService`. Regra de efeito: `entrega = acao==='enviar' || !exigeBotaoEnviar`. Mensagens em pt-BR, sem ecoar conteúdo do texto.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(entrega): EntregaService com validação e confirmação em duas fases"`

### Task 6: `UploadController` e ligação no módulo

**Files:**
- Create: `src/interface/rest/upload.controller.ts`
- Modify: `src/app.module.ts` (controllers; providers `UploadLinks`, `ConfirmacoesEntrega` como `useFactory`, `EntregaService`; exportar o que o `mcp-wiring` precisa, no molde de `DownloadLinks` nas linhas 146-152 e 493), `test/openapi.spec.ts` (`UploadController` em `OUTSIDE_CONTRACT`)
- Test: `src/interface/rest/upload.controller.spec.ts`

**Interfaces:**
- Consumes: `EntregaService.receberUpload` (Task 5), `EntregaInvalidaError`.
- Produces: `POST /upload/:id` multipart (campo `file`, até 20 partes via `AnyFilesInterceptor({ limits: { fileSize: 100 * 1024 * 1024, files: 20 } })`); 200 `{ arquivos: [{nome, tamanhoBytes}] }`; link inexistente/expirado/usado 404 `{ erro: 'LINK_INVALIDO', mensagem }`; `EntregaInvalidaError` 400; `SourceError` 502. Mesmos cabeçalhos de `headersSeguros` do `download.controller.ts` (extraí-la para um módulo compartilhado ou duplicar a função de 4 linhas).

- [ ] **Step 1: Write the failing tests** (Nest testing module com `supertest`, como os outros specs de controller; `EntregaService` falso): `'POST com um arquivo chama receberUpload(id, [{nome, bytes}]) e devolve a lista'`; `'link inválido: 404 LINK_INVALIDO'`; `'sem arquivo: 400'`; `'a resposta tem Cache-Control: no-store e Referrer-Policy: no-referrer'`; `'não ecoa o conteúdo do arquivo nem o id em erro'`.

- [ ] **Step 2: Run:** `npx jest src/interface/rest/upload.controller.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** o controller (mapeamento de erros no molde do `download.controller`), registrar no `app.module.ts` e em `OUTSIDE_CONTRACT`. Se faltar `@types/multer`, tipar `Express.Multer.File` localmente em vez de instalar pacote.

- [ ] **Step 4: Run** o spec do controller, `test/openapi.spec.ts`, `test/architecture.spec.ts`; depois `npm run build && npm test && npx tsc --noEmit -p tsconfig.json` (fecha o PR 2).

- [ ] **Step 5: Commit** — `git commit -m "feat(entrega): POST /upload/:id para o rascunho da tarefa"`

---

## PR 3: permissão e ferramentas MCP

### Task 7: Chave `moodle.assignment_write`

**Files:**
- Modify: `src/application/web/contract.ts` (`PERMISSION_KEYS`), `src/application/permissions/permissions.service.ts` (`PERMISSION_CATALOG`), `openapi.json` (regerado)
- Test: o spec existente de permissões (`grep -l "forum_write" src test`: o que testa o catálogo/oferta)

**Interfaces:**
- Produces: chave `'moodle.assignment_write'`, `source:'moodle'`, `risk:'high'`, título "Enviar tarefas do AVA pelo app", descrição em pt-BR: o app entrega trabalhos no AVA em seu nome, o professor passa a ver a entrega, a entrega não pode ser desfeita pelo app, cada envio pede a sua confirmação antes.

- [ ] **Step 1: Write the failing test**: o catálogo tem a chave com `risk:'high'` e `source:'moodle'`; a oferta (`OfferedPermission`) lista a chave só quando o Moodle está conectado (mesmo teste de `moodle.forum_write`, copiado e trocando a chave).
- [ ] **Step 2: Run** esse spec — Expected: FAIL.
- [ ] **Step 3: Implement** a chave e o texto; `npm run openapi`.
- [ ] **Step 4: Run** o spec e `test/openapi.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A src openapi.json && git commit -m "feat(permissoes): moodle.assignment_write"`

### Task 8: Ferramentas MCP, casos de uso e documentação

**Files:**
- Modify: `src/interface/mcp/mcp-ports.ts` (inputs e 3 métodos em `McpUseCases`), `src/interface/mcp/mcp-use-cases.ts` (adaptador fino sobre `EntregaService`; decodifica base64; monta `linkUpload = ${base}/upload/${id}` como `baixarAnexo` monta o de download), `src/interface/mcp/mcp-tools.ts` (3 `registerPermissionedTool(p, 'moodle.assignment_write', ...)`), `src/mcp-wiring.ts` (injetar `EntregaService`), `src/interface/mcp/testing/stub-mcp.ts`, `docs/MCP.md`, `docs/MOODLE.md`, `docs/WEB-API.md` (§ permissões e lista de ferramentas de escrita)
- Test: `src/interface/mcp/mcp-entrega.spec.ts` (molde de `mcp-postar-forum.spec.ts`)

**Interfaces:**
- Consumes: `EntregaService` (Task 5), chave (Task 7).
- Produces, em `mcp-ports.ts`:
  ```ts
  export interface PrepararEnvioInput { conta?: string; cursoId: string; tarefaId: string }
  export interface EnvioTarefaInput extends PrepararEnvioInput { texto?: string; uploadId?: string; arquivos?: { nome: string; conteudoBase64: string }[]; confirmacaoId?: string }
  // em McpUseCases:
  prepararEnvioTarefa(p: McpPrincipal, input: PrepararEnvioInput): Promise<unknown>;
  salvarRascunhoTarefa(p: McpPrincipal, input: EnvioTarefaInput): Promise<unknown>;
  enviarTarefa(p: McpPrincipal, input: EnvioTarefaInput): Promise<unknown>;
  ```
  Ferramentas: `preparar_envio_tarefa` (`readOnlyHint:true`), `salvar_rascunho_tarefa` e `enviar_tarefa` (`readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`). Nas duas últimas: sem `confirmacaoId` → `EntregaService.solicitar` e devolve `{ confirmacaoPendente: true, ...resumo }`; com `confirmacaoId` → `confirmar` e devolve `{ enviado: true | false, ...feita }` (`salvo` para rascunho). A descrição manda mostrar o resumo à pessoa e só repetir a chamada com o `confirmacaoId` depois de um "sim" dela; a de `preparar_envio_tarefa` explica o `curl -F "file=@arquivo" "<linkUpload>"` (um POST com todos os arquivos).

- [ ] **Step 1: Write the failing tests** em `mcp-entrega.spec.ts`: `'sem moodle.assignment_write nenhuma das três aparece'` (e com outra permissão também não); `'com a permissão as três aparecem; preparar é somente leitura, as outras são escrita não destrutiva'`; `'salvar_rascunho_tarefa e enviar_tarefa sem confirmacaoId chamam o caso de uso sem confirmacaoId'`; `'com confirmacaoId repassam o id'`; `'erro do caso de uso volta como erro da ferramenta com a mensagem'`. E em um spec do adaptador (`mcp-use-cases.spec.ts`, no padrão do existente): `'base64 é decodificado e vira bytes'`, `'base64 inválido é recusado'`, `'linkUpload usa baseUrl do principal'`.

- [ ] **Step 2: Run:** `npx jest src/interface/mcp/mcp-entrega.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** inputs/Zod (`cursoId`, `tarefaId` strings; `arquivos` até 20), adaptador, registro das ferramentas, wiring e stub; escrever as três seções nos docs (fluxo, regras de rascunho x entrega, limites, "salvar substitui", `itemid` do texto online não validado no AVA real).

- [ ] **Step 4: Run** `npm run build && npm test && npx tsc --noEmit -p tsconfig.json && npm run openapi && git diff --exit-code openapi.json` — Expected: tudo verde (fecha o PR 3).

- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): preparar_envio_tarefa, salvar_rascunho_tarefa e enviar_tarefa"`

---

## Depois de implementado (fora do plano de código)

Validação real, só com o OK do André: ED2 e ED3 pelo MCP (`preparar` → upload → `enviar_tarefa` com confirmação). A ED1 já foi entregue no spike.
