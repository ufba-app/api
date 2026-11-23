# Envio de tarefas no Moodle (AVA)

Status: **rascunho do design, aguardando aprovação do André** (2026-11-22). Nada implementado.

## Intenção

O aluno entrega tarefa do AVA pelo ufba.app. A regra de negócio vive na camada `application` (um caso de uso), a API REST do web vai reutilizar o mesmo caso de uso depois, e o MCP é só mais uma interface fina por cima. Por ora só o Moodle (padrão do `postar_forum`: método opcional na porta `LiveSource`, só o `MoodleLive` implementa).

## O que foi validado no AVA real (2026-11-22, conta do André, tarefa ED1)

- O `wstoken` do app móvel pode chamar `mod_assign_save_submission`, `mod_assign_submit_for_grading`, `mod_assign_get_submission_status` e `mod_assign_get_assignments`.
- `core_files_upload` não existe, mas `POST /webservice/upload.php` (campos `token`, `filearea=draft`, `itemid=0`, `file_1`) funciona e devolve `itemid` do rascunho. Limite do site: 100 MB.
- Fluxo que entregou: `upload.php` → `mod_assign_save_submission` com `plugindata[files_filemanager]=<itemid>`. Resposta `[]`.
- **Salvar pode ser entregar.** `mod_assign_get_assignments` traz `submissiondrafts`. Com `0` (caso da ED1), salvar já deixa a entrega `submitted`. Com `1`, salvar é rascunho e `submit_for_grading` entrega.
- `get_assignments` também traz as configs dos plugins (`file.enabled`, `file.maxfilesubmissions`, `file.maxsubmissionsizebytes`, `file.filetypeslist`, `onlinetext.enabled`), `duedate`, `cutoffdate`, `allowsubmissionsfromdate`, `requiresubmissionstatement`, `teamsubmission`.
- `get_submission_status` traz `status` (`new`/`draft`/`submitted`), `canedit` e os plugins da entrega.

## Objetivos

- Enviar arquivo(s) e/ou texto online, conforme a tarefa aceita.
- Nunca entregar por acidente: o agente mostra um resumo e a pessoa confirma antes de qualquer escrita.
- Ser honesto sobre o efeito: dizer se a ação vai só salvar ou vai entregar, lendo a configuração da tarefa antes.
- Reaproveitar o caso de uso na REST sem mudar regra.

## Não objetivos

- SIGAA e Classroom. Tarefa em grupo (`teamsubmission`). Declaração de autoria (`requiresubmissionstatement`): v1 recusa com mensagem para entregar pelo AVA. Apagar entrega, nota, feedback, quiz.
- Guardar o conteúdo do trabalho: nada é gravado no nosso banco.

## Anti-objetivos (seria falha mesmo funcionando)

- Entrega sem confirmação explícita da pessoa. Token ou conteúdo em log ou erro. Prometer "rascunho" quando salvar entrega.

## Restrições

- Permissão por app, chave nova **`moodle.assignment_write`** (risco `high`), registrada com `registerPermissionedTool`; sem ela as ferramentas nem aparecem em `tools/list`. Entra em `PERMISSION_KEYS` e `PERMISSION_CATALOG`; o texto da permissão diz que a entrega vai para o professor.
- Camadas: `domain` ← `application` ← `interface` (`test/architecture.spec.ts`). Testes sem rede (fetch simulado). Nomes de código em inglês, textos para a pessoa em pt-BR.
- Hoje a API roda uma instância no Railway; o estado de curta duração (links e confirmações) pode ficar em memória, como o `DownloadLinks`.

## Abordagens consideradas

1. **Uma ferramenta só**, com os bytes em base64 no argumento. Simples, mas MCP e base64 não servem para arquivo grande e o agente gasta contexto. Descartada como único caminho.
2. **Ferramentas em duas fases + link de upload temporário** (escolhida, aceita pelo André): espelha o `baixar_anexo` ao contrário. O agente pede o link, envia o arquivo com `curl`, depois confirma. Base64 fica como atalho para arquivo pequeno.
3. **Só REST, MCP chama a REST por HTTP.** Duplica autenticação e não aproveita o caso de uso. Descartada.

## Design (como o André decidiu)

**Ferramentas MCP** (todas com `moodle.assignment_write`, exceto onde dito):

- `preparar_envio_tarefa` (`cursoId`, `tarefaId`): lê configuração e estado e devolve: tipos aceitos, limites (quantidade, tamanho, extensões), prazo e se já passou, estado atual, **se salvar entrega ou só grava rascunho** (`submissiondrafts`), e o `linkUpload` de uso único (curto) quando a tarefa aceita arquivo. Não escreve nada.
- `salvar_rascunho_tarefa`: só funciona quando a tarefa exige o botão de enviar (`submissiondrafts=1`). Se não exigir, recusa dizendo que salvar entrega e manda usar `enviar_tarefa`.
- `enviar_tarefa`: entrega de fato. Com `submissiondrafts=0`: `save_submission` entrega. Com `1`: salva (se há conteúdo novo) e chama `submit_for_grading`.

**Confirmação em duas chamadas** (`salvar_rascunho_tarefa` e `enviar_tarefa`): a primeira chamada não escreve e devolve `resumo` (tarefa, arquivos com nome e tamanho, texto, o que vai acontecer, prazo, se substitui a entrega atual) e um `confirmacaoId` de uso único (10 min). A segunda, com esse `confirmacaoId`, executa. A descrição da ferramenta manda o agente mostrar o resumo à pessoa e só confirmar com um "sim" dela.

**Arquivos:** o `linkUpload` aponta para um endpoint novo, `POST /upload/:id` (multipart, em `interface/rest`, ao lado do `download.controller`; entra em `OUTSIDE_CONTRACT`). Ele valida tamanho e extensão contra a configuração da tarefa e **envia direto para a área de rascunho do próprio Moodle** (`upload.php`), guardando em memória só `{userId, conta, tarefaId, itemid, nome, tamanho}` com TTL. Nosso servidor não grava o arquivo. Atalho: `arquivos: [{ nome, conteudoBase64 }]` na `enviar_tarefa`, no máximo 2 MB somando tudo.

**Texto online:** `texto` (texto puro, escapado para HTML como no `postarForum`), só se a tarefa aceita.

**Camadas:**
- `application/ports/live-source.ts`: tipos neutros (`EntregaViva`, `RequisitosEntrega`, `EnvioTarefa`) e métodos opcionais `requisitosEntrega`, `enviarArquivoRascunho`, `salvarEntrega`, `finalizarEntrega`.
- `application/live/entrega.service.ts` (novo): valida regras (janela, tipos, limites, `canedit`, tarefa em grupo, declaração), cuida dos `confirmacaoId` e dos itemids em memória, escolhe salvar ou entregar. É o que a REST vai chamar.
- `infrastructure/sources/moodle/moodle-live.ts`: as quatro chamadas (`get_assignments` + `get_submission_status`, `upload.php`, `save_submission`, `submit_for_grading`), com os erros do `run()` (token recusado vira `REAUTH_NEEDED`).
- `interface/mcp`: as três ferramentas, finas. `interface/rest`: o endpoint de upload.

**Regras de validação** (antes de escrever): fora da janela (`allowsubmissionsfromdate`/`cutoffdate`) recusa; depois do `duedate` e antes do `cutoffdate` avisa "atrasada" no resumo e deixa seguir; `canedit=false` recusa; `teamsubmission=1` e `requiresubmissionstatement=1` recusam; arquivo ou texto que a tarefa não aceita recusa.

## Escolhas minhas (corrija se discordar)

- Salvar arquivos **substitui** o conjunto de arquivos da entrega atual (é assim que o Moodle trata o `files_filemanager`); o resumo avisa quando já existe entrega.
- `confirmacaoId` além do texto de instrução, para a segurança não depender só do agente obedecer.
- TTL: link de upload 15 min, confirmação 10 min.
- Declaração de autoria e tarefa em grupo ficam fora do v1.

## Fica para quem constrói

Formato exato dos erros novos no `API_ERROR_CODES` e no mapeamento do MCP; nomes finais dos campos de saída; se `preparar_envio_tarefa` precisa de `cursoId` ou se dá para achar o curso pelo `assignid` (o `get_assignments` filtra por curso); detalhes do multipart (limite no parser, streaming); documentação em `docs/MCP.md`, `docs/MOODLE.md` e `docs/WEB-API.md`.

## Testes e validação

- Unitários com `fetch` simulado, no molde de `moodle-forum-write.spec.ts`: requisitos, upload, salvar, entregar, recusas, confirmação expirada ou reutilizada, permissão ausente (ferramenta não aparece).
- Validação real, só depois de implementado: o André testa pelo MCP com a ED2 e a ED3. A ED1 já foi entregue no spike.

## Divisão em PRs

O repo está sem limite de linhas por PR (`claude.prMaxLines=0`, decisão do André). Mesmo assim, três PRs em sequência, cada um com testes verdes: (1) tipos da porta + chamadas do `MoodleLive` + testes; (2) `EntregaService` + staging em memória + endpoint de upload + testes; (3) ferramentas MCP + chave de permissão + docs + stub de teste.
