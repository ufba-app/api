# Moodle (UFBA)

Integração via **Web Service REST** do Moodle, com o `wstoken` da própria pessoa (obtido por SSO, ver abaixo). O código fica em `src/infrastructure/sources/moodle/`.

## Como funciona

- Cada conta Moodle (`SourceAccount`) tem uma `baseUrl` (UFBA: `https://ava.ufba.br`) e um `wstoken`, guardado **cifrado** pela plataforma. O gateway recebe os dois já resolvidos em `SourceContext`.
- Todas as chamadas são `POST {baseUrl}/webservice/rest/server.php` com `wstoken`, `wsfunction` e `moodlewsrestformat=json`.
- Autenticação declarada: `token-guardado` (ao contrário do SIGAA, não exige segredo por requisição).

| Função do Moodle | Vira |
|---|---|
| `core_webservice_get_site_info` | `userid` da pessoa (usado nas demais) |
| `core_enrol_get_users_courses` | `CourseSpace` |
| `core_course_get_contents` | `MATERIAL` (arquivos como anexos), `ASSESSMENT` (quiz) |
| `mod_assign_get_assignments` | `ASSIGNMENT` (`dueAt`, anexos da descrição) |
| `mod_forum_get_forums_by_courses` + `mod_forum_get_forum_discussions` | `ANNOUNCEMENT` (fórum `news`) e `FORUM_TOPIC` |
| `gradereport_user_get_grade_items` | `GradeEntry` |
| `core_calendar_get_calendar_upcoming_view` | eventos (só no escopo `tudo`) |

IDs externos: `cm<id>` (módulo), `assign<id>`, `disc<id>`, `gi<id>` (nota), `ev<id>` (evento).

## Anexos

O banco guarda só metadados + `sourceUrl` (sem token). `MoodleAttachmentReader.read(ctx, sourceUrl)` baixa o arquivo sob demanda, acrescentando `token=` à URL. Ele recusa URL de outro host (o token só vai para o Moodle da conta) e remove `token=` que o Moodle eventualmente devolva nas URLs. O token nunca é logado nem aparece em mensagens de erro.

## Arquivos do Drive linkados no conteúdo

Professores postam links do Google Drive/Docs no Moodle (URL de módulo, HTML da descrição, rótulo, descrição de tarefa, mensagem de fórum). Na leitura ao vivo (`ver_curso`, `ver_forum`) eles viram **anexos com `ref`**, e o `baixar_anexo` (mesmo fluxo de link temporário de uso único) entrega o arquivo **como ele é**; nativos do Google são exportados: **Docs e Apresentações → PDF, Planilhas → XLSX**. Nada fica guardado, nada de conteúdo vai para log.

- **Só o que apareceu no curso.** O `ref` é `gdrive1.<tipo>.<id>.<assinatura>`: HMAC (chave derivada da `SECRETS_KEY`) preso à pessoa. O agente não consegue fabricar o `ref` de um arquivo qualquer; ref adulterado, de outra pessoa ou URL é recusado antes de qualquer rede (`DriveRefs`, `src/infrastructure/sources/drive/`). Sem `SECRETS_KEY` o recurso fica desligado.
- **Só `drive.google.com` e `docs.google.com`** (`domain/drive/drive-link.ts`); formulários não viram anexo (pastas viram: ver abaixo); id validado (`[A-Za-z0-9_-]{10,128}`).
- **Como baixa** (`GoogleDriveDownloader`): 1º o token da pessoa (contas do Classroom conectadas, a `@ufba.br` primeiro; Drive API v3, `drive.readonly`); se nenhuma abrir, o link público (sem login). Sem acesso a nenhum: 403 `NO_ACCESS` com a dica de conectar o Classroom. Falha de rede/5xx é 502 (não vira "sem acesso").
- **Limites:** 25 MB (pelo `size` e pelo corpo lido), 30 s por requisição; no link público o redirect só é seguido dentro de hosts do Google (`drive.google.com`, `docs.google.com`, `drive.usercontent.google.com`, `*.googleusercontent.com`); redirect para o login do Google = arquivo privado.
- **O link do Drive sai de `links`** quando vira anexo: o agente deve usar a `ref` `gdrive1.…` com `baixar_anexo`; o link direto pede login (o MCP e as `instructions` dizem isso).
- **Onde o extrator procura links** (`MoodleLive.verCurso`, melhor esforço, só com `SECRETS_KEY`): URL do módulo `url`; descrição/intro de qualquer módulo (inclusive `assign`, `label`, `forum`); **corpo de `page`** (1 chamada `mod_page_get_pages_by_courses` para o curso todo; se falhar, o `index.html` de cada página); **capítulos de `book`** e **arquivos HTML de `resource`** (baixados com o token da conta, só do Moodle dela). Teto de 12 arquivos HTML por curso, 512 KB cada; falha de leitura só deixa de achar links, nunca derruba `ver_curso`. Fora: `wiki`, `lesson`, `glossary`, `data`, `h5p` e PDFs/DOCX (o conteúdo de arquivos não é aberto aqui).
- Custo de `ver_curso` no Moodle: 2 chamadas + 1 se houver módulo `page` + até 12 downloads de HTML.
- **Pastas do Drive** (`drive.google.com/drive/folders/...`): o extrator põe um anexo com `ref` de pasta (`gdrive1.folder.…`) e o `ConsultaService` o **expande** em `ver_curso`/`ver_forum`: **um anexo por arquivo do primeiro nível** (sem recursão), cada um com `ref` próprio, **assinado para a mesma pessoa** (o `ref` da pasta, que veio do curso, autoriza os filhos listados; `mimeType` e `tamanhoBytes` já vêm). Listagem pela Drive API v3 com o token da pessoa (contas do Classroom, a `@ufba.br` primeiro); sem acesso, só se o servidor tiver a variável `GOOGLE_DRIVE_API_KEY` (chave da API do Drive, opcional, restrita à Drive API; a API oficial lista pasta pública; sem ela, **não há** listagem pública: não raspamos a página do Drive). Tetos: 5 pastas expandidas por chamada, 100 itens por pasta, 200 anexos novos no total. **Vídeo, arquivo acima de 25 MB e subpasta não viram anexo**: vão em `abrirNoNavegador` com rótulo e tamanho ("Aula 01.mp4 (vídeo, 350 MB)", "Material (subpasta)") e o link para a pessoa abrir. Pasta que não deu para listar vira só o link ("não consegui listar os arquivos").
- **Vídeo e arquivo grande, antes de baixar:** o download consulta os metadados (`files.get` com nome, tipo e tamanho) e **não baixa** vídeo (qualquer tamanho) nem arquivo acima do teto; responde "\"Aula 01.mp4\" é um vídeo (350 MB): abra no navegador: <link>" (400). O `baixar_anexo` confere antes de gerar o link (1 consulta de metadados por arquivo do Drive pedido): se for bloqueado, devolve `aviso` + `abrirNoNavegador` e **nenhum link de download**. Link público sem token: o tipo vem do `content-type` (vídeo é recusado sem ler o corpo) e o tamanho do `content-length`.
- **Não coberto:** formulários, desenhos e subpastas (primeiro nível só); arquivos acima do teto (abrir pelo navegador).

## Entrega de tarefa (escrita)

Ferramentas MCP `preparar_envio_tarefa`, `salvar_rascunho_tarefa` e `enviar_tarefa`, só com a permissão `moodle.assignment_write` (`docs/MCP.md`). Regras no `EntregaService` (`src/application/live/entrega.service.ts`); chamadas no `MoodleLive`/`MoodleClient`.

| Função do Moodle | Para quê |
|---|---|
| `mod_assign_get_assignments` | Acha a tarefa pelo `cmid` (o `tarefaId` público = `id` da atividade em `ver_curso`) e lê o `id` interno (assign id) que as chamadas abaixo recebem; configuração da tarefa: `submissiondrafts`, plugins `file` (`enabled`, `maxfilesubmissions`, `maxsubmissionsizebytes`, `filetypeslist`) e `onlinetext.enabled`, `allowsubmissionsfromdate`, `duedate`, `cutoffdate`, `teamsubmission`, `requiresubmissionstatement` |
| `mod_assign_get_submission_status` | `status` (`new`/`draft`/`submitted`), `canedit`, os arquivos atuais e se há texto online (só se existe, nunca o texto) |
| `POST /webservice/upload.php` (`token`, `filearea=draft`, `itemid=0`, `file_1`, `file_2`...) | Sobe os arquivos à área de rascunho do aluno (invisível ao professor) e devolve o `itemid` |
| `mod_assign_save_submission` | Grava: `plugindata[files_filemanager]=<itemid>` e/ou `plugindata[onlinetext_editor][text\|format\|itemid]` (texto puro escapado para HTML) |
| `mod_assign_submit_for_grading` | Manda para avaliação (só em tarefa com o botão de enviar) |

- **Dois ids.** O `tarefaId` das ferramentas é o `cmid` (id do módulo, o que `ver_curso` mostra; ex.: `4258935`). `mod_assign_get_submission_status` (`assignid`), `mod_assign_save_submission` e `mod_assign_submit_for_grading` (`assignmentid`) querem o id interno da tarefa (ex.: `286293`). O `MoodleLive.requisitosEntrega` resolve um pelo outro (`RequisitosEntrega.tarefaId` = interno, `.cmid` = público), sem aceitar o id interno como `tarefaId`. Link de upload e confirmação ficam presos ao `cmid` (o que o agente manda); a confirmação guarda também o id interno e é ele que vai para a gravação (se a tarefa relida tiver outro id interno, recusa).
- **Salvar pode ser entregar.** Com `submissiondrafts=0` (tarefa sem o botão "Enviar tarefa"), `save_submission` já deixa a entrega `submitted`: não existe rascunho, `salvar_rascunho_tarefa` recusa e `enviar_tarefa` só salva. Com `submissiondrafts=1`, salvar é rascunho e `enviar_tarefa` salva (se há conteúdo novo) e chama `submit_for_grading`.
- **Regras antes de escrever:** fora da janela (`allowsubmissionsfromdate`/`cutoffdate`) recusa; depois do `duedate` e antes do `cutoffdate` segue, marcada "atrasada" no resumo; `canedit=false`, tarefa em grupo, declaração de autoria e **tarefa que aceita arquivo E texto online** recusam (v1: entregar pelo AVA; `preparar_envio_tarefa` devolve `podeEntregar: false` com o `motivo` e não abre link); arquivo ou texto que a tarefa não aceita recusa; quantidade, tamanho por arquivo e extensão conforme a tarefa. O `filetypeslist` pode ter extensões (`.pdf`), grupos (`document`, `image`, `archive`), MIME ou `*`: só uma lista feita só de extensões é conferida aqui (no nome que o Moodle recebe); com grupo, MIME ou `*` a lista vai como informação e o Moodle julga.
- **Depois de escrever:** a resposta da escrita tem de ser uma lista de avisos (`[]` = ok; outra coisa é falha; o texto do aviso sai sem o token e curto). Se a escrita deu certo e só a leitura do estado logo depois falhou, não é falha: a leitura é tentada até 3 vezes (pausas de ~400 ms e ~1200 ms, sem regravar) e, se nenhuma der, o serviço devolve estado `desconhecido` (conferir no AVA) com `motivoLeitura`, só um código (`errorcode` do Moodle, `HTTP_<status>`, `REDE`, `RESPOSTA_INVALIDA` ou `DESCONHECIDO`), e grava um aviso de formato fixo no log com o código e o número de tentativas (sem ids, conteúdo, token ou URL); se salvou e o `submit_for_grading` falhou, o erro diz que ficou rascunho e NÃO foi enviado. Antes de gravar, a tarefa é relida e a confirmação é recusada se o estado ou os arquivos atuais mudaram desde o resumo. O tamanho de cada arquivo no resumo vem dos bytes que enviamos (por posição, `file_1..n`), não do `filesize` da resposta do `upload.php`, que não o traz (em produção vinha 0). O POST do `upload.php` tem tempo limite de 120 s e não segue redirecionamento; ids com mais de 15 dígitos não chegam ao Moodle.
- **Limites:** link de upload de uso único, 15 min, até 20 arquivos, 25 MB por arquivo e 50 MB por envio (ou o limite menor da tarefa; um envio por link de cada vez e no máximo 2 envios em andamento no servidor, o resto recebe 429); confirmação de uso único, 10 min; `arquivos` em base64 só para arquivo minúsculo, cerca de 64 KB somados (o corpo do `/mcp` passa pelo parser JSON padrão, 100 kb); maior que isso, o link de upload.
- **Salvar substitui:** os arquivos novos substituem o conjunto atual da entrega (é como o `files_filemanager` funciona); o resumo avisa.
- **Validado no AVA real (2026-11-22, ED1):** `upload.php` → `save_submission` só com arquivos, em tarefa sem o botão de enviar, **entregou** (status `submitted`).

**Não validado no AVA real:**

1. O `itemid` do texto online (`onlinetext_editor[itemid]=0`): a única tarefa testada, a ED1, só aceita arquivo. Tarefa só de texto segue liberada com essa ressalva.
2. Se `save_submission` só com texto apaga os arquivos já entregues, ou só com arquivos apaga o texto já entregue. Por isso tarefa que aceita **arquivo e texto** é recusada em v1 (rascunho e envio), até isso ser verificado; tarefa só de arquivo (validada) e só de texto não são afetadas.
3. O caminho do rascunho em tarefa com o botão de enviar (`submissiondrafts=1`): `save_submission` como rascunho e depois `submit_for_grading`.

## Leitura da tarefa: entrega, nota e feedback (`ver_tarefa`)

Só leitura, sem a permissão `moodle.assignment_write`. `MoodleLive.verTarefa` usa as mesmas 2 chamadas e a mesma resolução `cmid` → assign id da entrega (helper `lerTarefaEStatus`); o `tarefaId` é sempre o `cmid` de `ver_curso`.

Formato real de `mod_assign_get_submission_status` (AVA da UFBA, conferido em leitura em 23/11/2026):

- **Sem nota:** a chave `feedback` **não existe**; `lastattempt.graded` é `false` e `gradingstatus` é `"notgraded"`. Vira `avaliacao: { avaliada: false, comentarios: [] }`, sem `nota` (nunca `0`).
- **Avaliada:** `lastattempt.graded: true` **e** `feedback` presente (com `graded` mas sem `feedback`, a nota não foi liberada ao aluno: `avaliada: false`). `feedback.gradefordisplay` vem em HTML (`"100,00&nbsp;/&nbsp;100,00"`, vira `"100,00 / 100,00"`; `"-"` = sem nota, some); `feedback.gradeddate` (segundos); comentário do professor em `feedback.plugins[type=comments].editorfields[name=comments].text` (HTML, ex. `<p>Excelente trabalho.</p>`). O plugin `editpdf` é ignorado. Comentário sem nota (tarefa sem nota ou professor que só comentou) sai em `comentarios` com `avaliada: false`. O plugin `comments` de `lastattempt.submission` é do aluno, não do professor.
- `submission.timemodified` (segundos) é `enviadoEm` **só com `status: submitted`** (em `new`/`draft`/`reopened` é a última edição); `atrasada` = envio depois de `extensionduedate` (se houver) ou do `duedate`; sem prazo ou sem entrega, `false`. Prazo sobrescrito por aluno/grupo (override) não é lido: usa o prazo base da tarefa.
- **Tarefa em grupo** (`teamsubmission: 1`): vale `lastattempt.teamsubmission` (a entrega do grupo, que pode ser de outro membro).
- Nada de ids do avaliador, `userid` ou id interno na saída.

## Como o token é obtido

O token é obtido pelo login no navegador da pessoa e colado **só na tela de conexão** do /authorize (link de redirecionamento `moodlemobile://token=...`); nunca entra por ferramenta MCP. O mecanismo é o `launch.php` do Moodle (`admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=<p>&urlscheme=moodlemobile`), que termina num redirect `moodlemobile://token=<base64>` com `<assinatura>:::<wstoken>[:::<privatetoken>]`. As funções puras de `token-launch.ts` (`buildLaunchUrl`, `newPassport`, `extractReturnedToken`, `parseReturnedToken`, `verifyPassport` = `md5(siteUrl + passport)`) montam a URL, interpretam o retorno e conferem a assinatura **antes** de confiar no token. O que muda é quem executa o login:

- **App antigo:** WebView que captura o redirect nativo (`ufba-app://`).
- **Plataforma (descartado):** redirect `https://` para página nossa. O Moodle valida o `urlscheme`, então não serve (ver "Spike 1").
- **Plataforma (adotado):** login no navegador da pessoa + colar o link na tela (ver `MoodleLink`). **Alternativa antiga, não adotada:** o **servidor** faz o SSO CAFe/Shibboleth com usuário e senha recebidos na requisição (senha só em memória, nunca guardada nem logada, como no SIGAA) e lê o header `Location: moodlemobile://token=…` sem seguir esse último redirect. A plataforma guarda só o `wstoken`, cifrado. Ver "Spike 2".

### Spike 1 — redirect para localhost/https: DESCARTADO

O Moodle valida o `urlscheme`; um callback `http(s)://` não é aceito. `scripts/moodle-spike.mjs` ficou no repositório só como registro e não precisa ser executado.

### Spike 2 — SSO feito pelo servidor

**Status: NÃO EXECUTADO contra o AVA real.** O script está pronto e foi testado apenas contra um servidor falso local (login, formulário SAML automático, redirect do app, senha errada). Nada abaixo presume que o CAFe da UFBA permita isso.

`scripts/moodle-sso-spike.mjs` (sem dependências novas; requer `npm run build`, porque reaproveita `parseReturnedToken`/`verifyPassport` de `dist/`):

1. `GET launch.php?service=moodle_mobile_app&passport=<p>&urlscheme=moodlemobile`, com cookie jar manual e redirects manuais.
2. Segue os redirects até o IdP (`cafe.ufba.br`); se a página do AVA só tiver um botão/link de login federado, segue o link.
3. Lê o formulário de login (campos hidden, `action`) e envia `MOODLE_USER`/`MOODLE_PASSWORD` (variáveis de ambiente).
4. Trata o POST automático de volta (`SAMLResponse`/`RelayState`) para o SP do AVA, e telas de continuação/consentimento do IdP.
5. Captura o `Location` com o esquema `moodlemobile://` (ou, se vier no corpo de uma página intermediária, avisa) e passa por `parseReturnedToken`/`verifyPassport`.
6. Valida com `core_webservice_get_site_info`.

Só imprime o passo atingido e o resultado (token mascarado; query strings de URL e o nome do usuário são omitidos). Nunca imprime senha, cookies nem HTML, e não grava nada em disco.

**Quando para** (e diz o passo e o motivo): captcha na página; segundo fator (campo/texto de código OTP); página que depende de JavaScript, sem formulário nem link utilizável; formulário de login que volta depois do envio (credencial rejeitada ou exigência extra); mais de 40 redirects; assinatura do passport que não confere.

Comando (bash), depois de `npm run build`:

```
MOODLE_USER='<usuario>' MOODLE_PASSWORD='<senha>' node scripts/moodle-sso-spike.mjs --verbose
```

`--verbose` lista cada salto como `host+caminho -> status`. Usar uma conta de teste, se possível; o histórico do shell guarda a linha acima, então prefira definir as variáveis sem gravar no histórico.

Resultado (preencher):

| Item | Resultado |
|---|---|
| Passo atingido | |
| Houve captcha / JS obrigatório / segundo fator? | |
| `Location: moodlemobile://` capturado? | |
| Assinatura confere? | |
| `core_webservice_get_site_info` OK? | |

Se funcionar, o fluxo vira um caso de uso do servidor (credencial `segredo-por-requisição` só para obter o token, depois `token-guardado`). Se parar num captcha/JS/2FA, a alternativa é interativa (navegador do próprio usuário), e este documento deve registrar o passo exato.

## Testes

`moodle.spec.ts` usa `fetch` simulado: nenhum teste acessa a rede nem usa dados reais.

## Pendências

- Paginação de discussões de fórum (`page`/`perpage`) ficou fora deste primeiro corte.
- `ver_curso`/`prazos` não trazem o estado da entrega (custaria 1 chamada por tarefa): ele sai de `ver_tarefa`, uma tarefa por vez. Nota do curso inteiro (`notas(cursoId)`, `gradereport_user_get_grade_items`, que dá 504 em alguns cursos) não existe: só a nota por tarefa, dentro de `ver_tarefa`.
