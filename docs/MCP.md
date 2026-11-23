# Servidor MCP

O serviço expõe ferramentas MCP por **Streamable HTTP** em `POST /mcp` (sem sessão: cada requisição é independente; `GET` e `DELETE` respondem 405). O código fica em `src/interface/mcp`.

## Modelo: autenticação + leitura ao vivo, sem banco de conteúdo

1. **Autenticação e nada mais.** A tela de `/authorize` faz o login (Google @ufba.br) e conecta as fontes; o serviço guarda só o acesso (token cifrado) e, no máximo, faz **uma leitura de teste** para confirmar que ele funciona. Não há sincronização.
2. **Leitura sob demanda.** Cada ferramenta vai à fonte **na hora da pergunta**, com o token da pessoa, e faz **só as chamadas daquela pergunta**: nunca varre curso por curso. O conteúdo não é gravado.
3. **Anexos vão para a máquina de quem pergunta**, por link temporário de download.

## Ferramentas (Moodle, Classroom e SIGAA)

Toda ferramenta de leitura aceita `fonte` (`moodle`, padrão, `classroom` ou `sigaa`) e `conta`. Cada consulta lê **uma conta de uma fonte**.

| Ferramenta | O que faz | Chamadas: Moodle | Chamadas: Classroom | Requisições: SIGAA |
|---|---|---|---|---|
| `listar_contas()` | Contas conectadas por fonte (`status: reconectar` quando o acesso foi recusado) | 0 (só banco) | 0 (só banco) | 0 (só banco; o SIGAA só aparece com token OAuth que traz a chave do cliente) |
| `listar_cursos(todas?)` | Matérias em andamento (`todas: true` inclui passadas/futuras) | 1 | 1 | 1 (portal do discente; só o semestre atual, `todas` é ignorado) |
| `prazos()` | Próximos prazos das matérias atuais. Ponto de partida para "o que tenho para hoje" | 1 (calendário) | 1 + 1 por matéria ativa, até 15 (a API não tem calendário agregado) | 1 + 2 + 3×(N−1), até 8 turmas (portal; 1ª turma: entrar + avaliações; as demais: portal fresco + entrar + avaliações; no máximo 24); só avaliações de hoje em diante |
| `ver_curso(cursoId)` | Tarefas (descrição + prazo), materiais, avisos, provas e fóruns de **uma** matéria | 2 | 3 | 5 (portal, entrar na turma, notícias, avaliações, tópicos de aula) |
| `ver_forum(forumId)` | A lista de **tópicos** de um fórum do Moodle (inclui o de avisos), com a mensagem inicial e o `id` de cada um | 1 | não existe | ainda sem suporte |
| `listar_alunos(cursoId)` | Nomes dos **alunos** de uma matéria (papel `student`), em ordem alfabética, com o total. Só o nome: sem e-mail, id ou contato. Professores e monitores ficam de fora. No Classroom exige o escopo `classroom.rosters.readonly`: quem conectou antes precisa reconectar | 1 | 1 por página de 50 alunos (até 10 páginas) | ainda sem suporte |
| `ver_topico(discussaoId)` | Todas as **mensagens de um tópico**, com as respostas, em ordem (`postId` e `respostaA`). O `discussaoId` vem de `ver_forum` | 1 | não existe | ainda sem suporte |
| `ver_aviso(avisoId)` | Texto completo de **um** aviso/notícia (`id` de um item `tipo: aviso` de `ver_curso`) | não existe | não existe | 4 (portal, entrar na turma, lista de notícias, clique "Visualizar"; POST direto em `mostrar.jsf` volta sem a notícia) |
| `baixar_anexo(ref \| anexos[])` | Links de download temporários (uso único, ~10 min) + comandos `curl` prontos. O arquivo é buscado quando o link é usado | 0 (+1 por download) | 0 (+3 por download: confere o anexo no post, metadados e conteúdo do Drive) | ainda sem suporte |

No Classroom, a renovação do access token (cache em memória) é uma chamada extra no máximo a cada hora. No SIGAA, o login (4 requisições) só acontece quando não há sessão guardada para aquela **pessoa** (vale para qualquer cliente), ela passou de 20 min sem uso ou o SIGAA a expirou; as consultas da mesma pessoa rodam uma por vez (fila em processo e trava no banco) e cada consulta recomeça pelo portal (o ViewState nunca é guardado). Os tetos são protegidos por teste (`test/mcp-integration.spec.ts` com o `MoodleLive` real; `classroom-live.spec.ts`; `sigaa-live.spec.ts`).

**`prazos` do SIGAA — leitura real de 16/11/2026:** a versão que lia o portal UMA vez e reaproveitava o `ViewState` da última página nas turmas seguintes **falhou** no SIGAA real (a entrada voltava sem o menu da turma, `form#formMenu`). A sequência agora é a do app antigo (conferida contra o SIGAA real): **antes de cada entrada o portal é relido** (GET fresco, com ViewState e tokens novos; a turma é achada nele pelo nome) e só a 1ª turma aproveita o portal já lido. Se a 1ª entrada ainda volta sem o menu (sessão retomada que o SIGAA não aceita), lança-se `SigaaSessionExpiredError` e o `SessoesSigaa` faz **um login novo e uma nova tentativa**, como o app antigo, que sempre logava. O bounce deixa no log só a **impressão digital** da página (tamanho, título curto, marcas portal/login/menu/expirada), nunca o corpo, o ViewState nem o token. Se ainda falhar, `prazos` falha com `UNAVAILABLE` ("página inesperada"), nunca com lista parcial ou vazia; o calendário do Painel mantém as aulas e marca `sigaa: failed`.

No SIGAA, `ver_curso` traz notícias como `tipo: aviso` (só o título; o texto vem de `ver_aviso`), avaliações como `tipo: prova` (prazo com a data e a hora do SIGAA, fuso da Bahia, UTC-3) e tópicos de aula como `tipo: material`. O `cursoId` é o nome da turma normalizado (ex.: `sistemas-operacionais`), como vem de `listar_cursos`.

**Várias contas na mesma fonte** (ex.: Classroom no gmail pessoal e no @ufba.br): o cliente escolhe. `listar_contas` mostra as contas; as outras ferramentas recebem `conta` e leem só ela. Sem `conta`, vale a única conta da fonte; com mais de uma, a ferramenta responde com erro listando as contas (sem chamar a fonte). Para ler todas, o cliente consulta uma por vez. Os links de `baixar_anexo` guardam a conta de origem.

**Download:** `GET /download/:id`. O id (aleatório, uso único, ~10 min) é a própria credencial, sem Bearer, para funcionar com `curl`/navegador na máquina da pessoa. Os links ficam só em memória (morrem ao reiniciar; não valem entre instâncias).

**Chat web (sem terminal):** para clientes de chat web (`isWebChatClient`), `baixar_anexo` não devolve `comoBaixar` (curl): devolve `link` + `comoLer`, e o Claude abre o link com a ferramenta de leitura de URL (nada de conteúdo passa pelo MCP). Esse link vale **10 min e 3 acessos** (a ferramenta de URL pode repetir a requisição), é `inline`, leva o nome do arquivo no fim (`/download/<id>/aula.pdf`, só para inferir o tipo) e responde `HEAD` sem gastar acesso. Toda resposta de download traz `Cache-Control: no-store`, `X-Robots-Tag: noindex` e `Referrer-Policy: no-referrer`. Terminal/editor/cliente desconhecido seguem com link de uso único e `curl`. **Não verificado:** se o claude.ai web consegue abrir o link e ler o arquivo (PDF, DOCX, planilha); depende da ferramenta de URL dele (teste real com o Andre).

**Segredos não passam por ferramentas.** Tokens do Moodle e do Google e a senha do SIGAA entram só pela tela de autorização; nenhuma ferramenta aceita senha ou token.

**Removido (04/11/2026):** `sincronizar`, `listar_itens`, `agenda`, `mudancas`, `perfil`, `historico`, `insights`, `importar_historico`, `ler_anexo` e as rotas REST equivalentes, junto com o motor de sincronização e o histórico. As tabelas do banco continuam no esquema, sem uso.

### Escrita: `postar_forum` (fórum do Moodle)

Publica no fórum do AVA em nome da pessoa, em **nova discussão** (`forumId`, o de `ver_curso`) ou em **resposta** (`postId`, o de `ver_forum`), com `titulo` e `mensagem` (texto puro, escapado e enviado como um parágrafo por linha). Chama `mod_forum_add_discussion` ou `mod_forum_add_discussion_post`: 1 chamada ao Moodle, nada é gravado no serviço.

- **Só existe com a permissão `moodle.forum_write`** (ligada ao app na tela de autorizar, em Apps autorizados). Sem ela a ferramenta nem aparece em `tools/list`. Risco alto: o web pede confirmação antes de ligar.
- A permissão aparece na tela de autorizar mesmo sem o Moodle conectado, marcada como indisponível (`source_not_connected`), como já acontece com o SIASB.
- Validação antes de tocar o AVA: exatamente um destino (`forumId` ou `postId`), título de 1 a 255 caracteres, mensagem de 1 a 10000.
- Anotações: `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`. A publicação não tem como ser desfeita pelo app e fica visível para a turma e o professor; a descrição da ferramenta manda o agente mostrar o texto e só publicar depois que a pessoa confirmar.
- Só o Moodle. Classroom não tem fórum; SIGAA não tem escrita.
- Ainda não testada contra o AVA real (depende do serviço de Web Service do AVA liberar essas duas funções para o token do app).

### Escrita: entrega de tarefa do Moodle

Três ferramentas, **todas só com a permissão `moodle.assignment_write`** (risco alto; sem ela nenhuma aparece em `tools/list`, nem a de leitura). São finas sobre o `EntregaService` (`src/application/live/entrega.service.ts`), que tem as regras; detalhes das funções do Moodle em `docs/MOODLE.md`. Nada do trabalho é gravado no serviço nem vai para log ou erro (só nomes e tamanhos).

| Ferramenta | O que faz | Anotações |
|---|---|---|
| `preparar_envio_tarefa(cursoId, tarefaId)` | Lê o que a tarefa aceita (`aceita.arquivos`/`aceita.texto`, `limitesArquivos`), prazo e `atrasada`, `estado`, `arquivosAtuais` e **`salvarJaEntrega`** (tarefa sem o botão de enviar). Se aceita arquivo, abre um `linkUpload` de uso único (15 min, `expiraEm`) com `uploadId` e `comoEnviar`. Não grava | `readOnlyHint: true` |
| `salvar_rascunho_tarefa(...)` | Salva como rascunho; só em tarefa **com** o botão de enviar (sem ele, recusa e manda usar `enviar_tarefa`) | escrita não destrutiva, não idempotente |
| `enviar_tarefa(...)` | Entrega ao professor. Sem conteúdo novo, manda para avaliação o rascunho que já está no AVA | escrita não destrutiva, não idempotente |

Entrada das duas de escrita: `cursoId`, `tarefaId`, `conta?`, `texto?` (texto puro), `uploadId?` (do link) **ou** `arquivos?: [{ nome, conteudoBase64 }]` (até 20; atalho para arquivo pequeno, no máximo **2 MB somados**, conferido pelo `EntregaService`; o schema só limita cada base64 a ~2,8 milhões de caracteres) e `confirmacaoId?`. Base64 inválido é recusado antes de chamar o serviço.

**Confirmação em duas chamadas.** Sem `confirmacaoId`, a ferramenta valida tudo e devolve `{ confirmacaoPendente: true, confirmacaoId, expiraEm, tarefa, arquivos (nome e tamanho), texto, efeito, prazo, atrasada, substituiEntrega, instrucao }` **sem gravar a entrega** (arquivos em base64 já sobem à área de rascunho do próprio Moodle, invisível ao professor). O agente mostra o resumo à pessoa e só repete a chamada com o `confirmacaoId` (uso único, 10 min, preso à pessoa e à ação) depois de um "sim" dela. Com `confirmacaoId`, grava: `enviar_tarefa` devolve `{ enviado, estado, entregue }` (`enviado` = ficou entregue); `salvar_rascunho_tarefa` devolve `{ salvo: true, estado, entregue }`. As descrições dizem: a entrega vai ao professor e não pode ser desfeita por aqui; em tarefa sem o botão de enviar salvar já entrega (usar `enviar_tarefa`, nunca prometer rascunho); salvar arquivos **substitui** os arquivos atuais; nunca confirmar sem o "sim" explícito.

**Link de upload.** `POST /upload/:id` (`src/interface/rest/upload.controller.ts`, fora do contrato OpenAPI): multipart, **todos os arquivos num único POST**, qualquer nome de campo, uso único; o id é a credencial (sem Bearer). Os arquivos são validados contra a tarefa (quantidade, tamanho, extensão) e vão direto para a área de rascunho do Moodle; o serviço guarda em memória só `itemid`, nomes e tamanhos. Depois, `uploadId` vai em `enviar_tarefa` ou `salvar_rascunho_tarefa`.

```bash
curl -fS -F "file=@relatorio.pdf" -F "file=@anexo.zip" "https://api.ufba.app/upload/<uploadId>"
```

Erros do link: 404 `LINK_INVALIDO` (expirado, usado ou inexistente), 413 `ARQUIVO_GRANDE_DEMAIS`, 400 `ENVIO_INVALIDO`/`SEM_ARQUIVO`. Tarefa em grupo ou com declaração de autoria é recusada (entregar pelo AVA).

### Metadados para a loja e uso sem dizer "UFBA"

- Toda ferramenta tem `title` e `annotations` (`readOnlyHint` e `destructiveHint`). As acadêmicas e as `clinica_*` de leitura são somente leitura; as de escrita (`postar_forum`, `salvar_rascunho_tarefa`, `enviar_tarefa` e as 4 do SIASB, todas atrás de permissão; `preparar_envio_tarefa` também fica atrás de `moodle.assignment_write`, mas é somente leitura) têm `readOnlyHint: false` (desmarcar sessão e excluir procedimento também `destructiveHint: true`); as `memory_*` seguem a classificação da casa (`memory-tool-meta.ts`), nunca as anotações do servidor remoto. Gravações que sobrescrevem ou retiram conteúdo (`memory_write_page`, `memory_patch_page`, `memory_write_pages_batch`, `memory_message_pop`, `memory_consolidate`) são destrutivas.
- O proxy dá `type` a toda propriedade do `inputSchema` que o ai-memory manda sem (a loja recusa). `test/mcp-store-compliance.spec.ts` percorre todas as ferramentas e falha se faltar `type`, `title` ou anotação.
- As `instructions` do servidor (`ACADEMIC_INSTRUCTIONS`) mandam o Claude usar o conector em qualquer conversa de contexto acadêmico (prova, prazo, matéria, estudar), mesmo sem a pessoa citar a UFBA.

## Ferramentas das clínicas (SIASB)

As ferramentas `clinica_*` de leitura leem o **SIASB** (clínicas-escola) ao vivo, em nome da pessoa, e **não gravam nada**. Quatro ferramentas de escrita existem, opt-in por permissão do app (seção abaixo). Não usam `fonte` nem `conta`: o SIASB tem uma conexão por pessoa e não passa pela `LiveSource`. Detalhes, rotas permitidas e privacidade em `docs/SIASB.md`.

**Visibilidade:** as 7 de leitura só aparecem na lista de ferramentas da pessoa que tem conexão SIASB **em qualquer estado** (conectada ou a reconectar). Sem conexão, não existem. A decisão é por requisição; se falhar ao resolver, vale "não mostrar". Conexão perdida (401 do SIASB, conta marcada) responde "Sua conexão com o SIASB expirou. Entre de novo no painel."

| Ferramenta | O que faz | Requisições: SIASB (máx.) |
|---|---|---|
| `clinica_situacao()` | Por disciplina: `estado` (`sem_paciente`, `sem_sessao`, `sessao_marcada`), `proximaClinica` e `prazoEstimado` | 3 |
| `clinica_sessoes(de?, ate?, aoVivo?)` | Sessões no intervalo (padrão: próximos 14 dias; até 45 dias à frente): horário, local, professor, primeiro nome, situação, `reagendamentoPara`. Por padrão lê a cópia da última sincronização, sem consultar o SIASB, e devolve `origem: 'copia'`, `atualizadoEm` (ISO ou `null`) e `desatualizado`. Com `aoVivo: true`, ou enquanto a pessoa não tiver nenhuma sincronização, consulta o SIASB na hora (`origem: 'ao_vivo'`) | 0 (cópia) ou 1 (ao vivo) |
| `clinica_prazo_marcacao(disciplinaId \| inicioSessao)` | Prazo estimado para marcar paciente; passe exatamente um dos dois | 1 (`disciplinaId`) ou 0 (`inicioSessao`) |
| `clinica_pacientes()` | Atendimentos ativos por disciplina: `atendimentoId`, `primeiroNome`, `tipo` | 2 |
| `clinica_vagas()` | Quantos pacientes sem responsável há por disciplina (só números) | 2 |
| `clinica_contexto_agendamento(atendimentoId, busca?)` | Duração da sessão, sessões já feitas (janela de 60 dias), procedimentos do catálogo (50 primeiros ou filtrados por `busca`) e até 3 próximos horários com prazo estimado | 4 |
| `clinica_progresso(desde?, ate?)` | Por disciplina: ativos, concluídos no período e no histórico, sessões atendidas e marcadas adiante; ritmo semanal e avisos. `desde` e `ate` juntos (até 190 dias) ou nenhum (últimos 120 dias, aproximado) | 4 |

- **Prazo estimado, não oficial:** 2 dias úteis antes da sessão, mais 1 dia útil de margem enquanto não houver calendário oficial (`feriadosConsiderados: false`, com aviso). Todo texto diz "prazo estimado".
- **Horários** saem com offset da Bahia (`-03:00`, fixo). Datas sem hora valem a hora da Bahia.
- **Privacidade:** só o primeiro nome do paciente; nunca o sobrenome nem prontuário; a lista de pacientes sem responsável nunca é lida por `clinica_vagas`.
- **Segredos:** nenhuma ferramenta aceita senha ou cookie; a conexão é feita no painel (`POST /connections/siasb`).

### Ferramentas de escrita do SIASB

Só aparecem para o app que a pessoa autorizou com a permissão (marcada na tela de autorizar, revogável em Apps autorizados; padrão negado) **e** que tem conexão SIASB. `siasb.schedule_write` libera `clinica_agendar_sessao` e `clinica_desmarcar_sessao`; `siasb.procedures_write` libera `clinica_incluir_procedimento` e `clinica_excluir_procedimento`. Todas têm `confirmado` (booleano, padrão `false`).

| Ferramenta | Parâmetros | Regras |
|---|---|---|
| `clinica_agendar_sessao` | `atendimentoId`, `inicio` (ISO 8601 **com fuso**), `duracaoMin` (15 a 240), `quantidade` (1 a 20, padrão 1), `professorId?`, `localId?`, `grupoId?`, `observacao?`, `confirmado` | atendimento ativo; semanal, mesmo horário, tudo ou nada; início futuro e até 365 dias (a última sessão também); ids entre as opções do SIASB |
| `clinica_desmarcar_sessao` | `sessaoId`, `motivo?`, `confirmado` | só sessão FUTURA marcada de atendimento ativo; **nunca registra falta** |
| `clinica_incluir_procedimento` | `atendimentoId`, `procedimentoId` (do catálogo, de `clinica_contexto_agendamento`), `dente?`, `face?`, `observacao?`, `confirmado` | fica PREVISTO; **realizar não existe**, é no site |
| `clinica_excluir_procedimento` | `atendimentoId`, `procedimentoId` (o devolvido por `clinica_incluir_procedimento`, não o do catálogo), `confirmado` | só exclui procedimento **incluído por esta ferramenta** (auditoria `procedure_add` ok da pessoa, no atendimento, com esse id); os demais, pelo site |

**Duas etapas.** Sem `confirmado: true` a ferramenta não escreve: devolve `status: "resumo"` (`resumo`, `detalhes`). A descrição manda o Claude mostrar o resumo e esperar o OK explícito da pessoa antes de repetir com `confirmado: true`, que devolve `status: "feito"` (`resumo`, `detalhes`, com `verificado` e `datasConfirmadas` ao agendar, `verificado` ao desmarcar e `procedimentoId`, ou `null`, ao incluir). Ao agendar sem professor, local ou grupo: `status: "escolher"` com `faltando`, `opcoes` (professores, locais, grupos) e `instrucao` (a pessoa escolhe; o Claude chama de novo **sem** `confirmado` para receber o resumo e só então pede o OK). Horários em `detalhes` (`datas`, `datasConfirmadas`, `inicio`) vêm na hora da Bahia com `-03:00`, como nas leituras; o `inicio` recebido é arredondado para o minuto inteiro (segundos descartados).

**Erros** (mensagens fixas): `entrada_invalida`, `siasb_write_rejected`, `siasb_write_unknown` ("O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo."; sem retry, a pessoa confere o site) e o de reconexão. Cada tentativa de escrita vai para a auditoria `siasb_write_audit` (sem texto livre; ainda sem expurgo de 90 dias).

Rotas de escrita permitidas, verificação depois de gravar, ressincronização e lacunas conhecidas (formatos de resposta nunca confirmados ao vivo, `procedimentoId` nulo ou deduzido): `docs/SIASB.md`, seção 14.

## Autenticação

`Authorization: Bearer <token>`. Sem token válido: `401`. O token é um destes:

1. **Access token OAuth 2.1** do próprio serviço (fluxo abaixo): o que clientes como o Claude usam.
2. **Chave de API** `plt_...` (atalho para scripts e para configurar o cliente hoje; emitida em `POST /usuarios`).

Sem token válido o `/mcp` responde `401` com `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`, que é como o cliente descobre o fluxo OAuth.

## Configurar o cliente

### Claude Code, com chave de API (hoje)

```bash
claude mcp add --transport http plataforma http://localhost:3000/mcp \
  --header "Authorization: Bearer SUA_CHAVE_DE_API"
```

### Claude Code, com OAuth

```bash
claude mcp add --transport http plataforma http://localhost:3000/mcp
```

Depois, dentro do Claude Code, `/mcp` → `plataforma` → autenticar. O navegador abre a tela de autorização do serviço.

### JSON (`.mcp.json` / `claude_desktop_config`-like)

```json
{
  "mcpServers": {
    "plataforma": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${PLATAFORMA_API_KEY}"
      }
    }
  }
}
```

Para OAuth, omita `headers`.

## Servidor OAuth 2.1

| Endpoint | Função |
|---|---|
| `GET /.well-known/oauth-protected-resource` | Metadados do recurso (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Metadados do servidor (RFC 8414) |
| `POST /register` | Registro dinâmico de cliente (RFC 7591), cliente público |
| `GET /authorize` | Só redireciona: login do web (`ufba-web`) vai ao Google; os demais clientes, à tela de consentimento do app web (`{AUTH_ORIGIN}/authorize?request=<id>`). O backend não tem telas. |
| `POST /token` | `authorization_code` com **PKCE S256 obrigatório** e `refresh_token` (rotativo) |

Regras: `redirect_uri` só `https` (ou `http` em `localhost`/`127.0.0.1`) e comparada exatamente com a registrada; `code` vale uma vez e 5 minutos; access token 1 h, refresh 30 dias; tokens são guardados só como hash SHA-256.

### Login, consentimento e conexões (no app web)
Todas as telas são do app web (contrato em `docs/WEB-API.md`); o backend só expõe a API.
1. **Entrar com Google** (conta institucional `@ufba.br`, só `openid email profile`; domínio em `GOOGLE_ALLOWED_DOMAIN`). Cria ou reconhece o usuário.
2. **Conectar Classroom** (dá para conectar mais de uma conta; antes de guardar, 1 leitura de teste). Escopos `classroom.*.readonly` + `drive.readonly` (para os anexos):
   - **@ufba.br** → app **interno** do login (sem verificação, sem limite de usuários, sem expiração);
   - **outra conta (convidados)** → app **externo** em "Testando": só quem estiver na lista de usuários de teste (até 100, adicionados à mão), e o acesso expira em 7 dias.
   O app é escolhido pelo domínio do e-mail, na conexão e na leitura.
3. **Conectar Moodle** (opcional): a pessoa faz o login institucional no PRÓPRIO navegador (`launch.php`) e o token volta pelo esquema `web+ufba` (ver abaixo). O servidor confere a assinatura do passport, valida o token no Moodle e guarda só o `wstoken`, cifrado.
4. **Conectar SIGAA** (opcional): usuário e senha, validados na hora com 1 login real; a senha fica cifrada com uma chave que só o cliente OAuth carrega (ver "SIGAA: senha cifrada com a chave do cliente" abaixo).

### SIGAA: senha cifrada com a chave do cliente

O SIGAA não tem token nem API: a leitura ao vivo precisa de usuário e senha a cada login. A senha fica guardada **cifrada com uma chave K que o servidor não guarda**: K viaja só dentro do token OAuth do cliente (ex.: o Claude) que a pessoa autorizou.

**Fluxo**

1. No app web, a pessoa informa usuário e senha do SIGAA. `SigaaLink` faz 1 login real (e lê o portal) para validar; se o SIGAA recusar, a tela avisa e nada é guardado. A tela nunca devolve o que foi digitado.
2. Validados, login e senha ficam **só em memória** (`CofreSigaa`), presos à transação (15 min) e depois ao `code` OAuth (5 min).
3. No `POST /token`, o cofre sorteia K (32 bytes), cifra a senha com AES-256-GCM sob K, grava o cifrado e tira a senha do cofre em memória. K vai no fim do access token e do refresh token (`<token>.<K em base64url>`); o refresh rotativo repassa K ao novo par. Falha ao gravar não derruba o `/token`: o token sai sem K e o SIGAA pede nova conexão.
4. Em cada consulta com `fonte: sigaa`, o `ConsultaService` separa K do token, e o `SigaaLive` usa a sessão do SIGAA **da pessoa** (`SessoesSigaa`, tabela `sigaa_sessions`: só o cookie, cifrado com a `SECRETS_KEY`; 20 min sem uso). A senha só é aberta **em memória** quando é preciso logar (sessão ausente, parada ou expirada): a K do cliente que consulta funciona como um refresh token. Sessão expirada (formulário de login ou `302` para `/sigaa/expirada.jsp`, observado no SIGAA real em 14/11/2026): reloga uma vez e refaz. Senha recusada pelo SIGAA marca a credencial como `REAUTH_NEEDED` (`listar_contas` mostra `status: reconectar`); a pessoa conecta de novo na tela de autorização.
5. Sem K (chave de API `plt_`, ou token emitido sem SIGAA conectado), as ferramentas com `fonte: sigaa` respondem "SIGAA não conectado" **sem nenhuma requisição ao SIGAA** (testado em `test/mcp-integration.spec.ts`).

**O que o banco guarda** (`sigaa_credentials`, uma linha por pessoa + cliente OAuth): `user_id`, `client_id`, `login`, a senha cifrada (`secret_ciphertext`, `secret_iv`, `secret_auth_tag`) e `status`. **Não** guarda K nem a senha em claro. O cookie da sessão fica em `sigaa_sessions` (uma linha por pessoa + login do SIGAA, cifrado, sem ViewState), que também guarda a trava (lease de 2 min, vence sozinha) das consultas da pessoa entre instâncias. Os tokens OAuth são guardados só como hash SHA-256 (do token inteiro, com K), então o banco sozinho não abre a senha. A conta do SIGAA em `source_accounts` nunca guarda segredo. Cada cliente autorizado tem a sua K e a sua linha.

**Nunca vão para log nem para mensagem de erro**: a senha, K, o JSESSIONID e o corpo das respostas do SIGAA. Os erros do `SigaaLive` têm mensagens fixas.

**Risco residual aceito:** quem controla o **servidor em execução** (ou o código que ele roda) vê a senha em memória durante uma consulta, e K em cada requisição. Cifrar com a chave do cliente protege contra vazamento do banco e de backups, não contra um operador malicioso. **Mitigação:** o código é aberto, então dá para auditar o que o servidor faz com a senha; quem não confia no operador não conecta o SIGAA (as outras fontes funcionam sem ele).

### Variáveis de ambiente

| Variável | Uso |
|---|---|
| `PUBLIC_URL` | URL pública do serviço (atrás de proxy/TLS); sem ela, deduz da requisição |

## Como está ligado

A composição fica em `src/mcp-wiring.ts` (raiz de `src`, a única que enxerga `interface` e `infrastructure`) e entra no `AppModule`. Não há stubs em produção:

| Peça | Implementação |
|---|---|
| Casos de uso das ferramentas | `McpUseCasesImpl` → `ConsultaService` (resolve a conta, decifra o token em memória, chama a `LiveSource`) e `DownloadLinks` |
| Leitura ao vivo | `LiveSources` → `MoodleLive` (`src/infrastructure/sources/moodle/moodle-live.ts`). Token recusado marca a conta `REAUTH_NEEDED` e pede para reconectar |
| Autenticação do `/mcp` e do REST | `AUTHENTICATORS` = `[IdentityService (chave plt_), OAuthAccessTokenAuthenticator]`. **Bearer ausente ou inválido → 401** (testado em `test/mcp-integration.spec.ts`) |
| OAuth (clientes, códigos, tokens) e usuários | Postgres (`PrismaOAuthStore`, `PrismaUserDirectory`; migração `20261031120000_oauth`, que só acrescenta tabelas e `users.email`) |
| Login Google | `GoogleOAuthLink`: app **interno** (`GOOGLE_CLIENT_ID/SECRET`), só identidade @ufba.br; não guarda nada |
| Vínculo Classroom | `ClassroomLink`: app **externo** (`GOOGLE_CLASSROOM_CLIENT_ID/SECRET`); 1 leitura de teste (`courses?pageSize=1`); grava o refresh token cifrado em `CLASSROOM`, uma conta por e-mail |
| Leitura do Classroom | `ClassroomLive` (`src/infrastructure/sources/classroom/classroom-live.ts`), com `GoogleAuth` do app do Classroom (o refresh token só renova com o cliente que o emitiu) |
| Vínculo SIGAA | `SigaaLink` (1 login de validação) → `CofreSigaa` (senha em memória até o `/token`; depois cifrada com K em `sigaa_credentials`) |
| Leitura do SIGAA | `SigaaLive` (`src/infrastructure/sources/sigaa/sigaa-live.ts`) com os parsers da turma virtual copiados do ufba-app (`sigaa/turma-virtual/`) e `SessoesSigaa` (sessão por pessoa guardada no banco, com trava entre instâncias) |
| Vínculo Moodle | `MoodleLink`: `launchUrl` (passport derivado por HMAC de usuário + transação, sem estado) e `connect` (extrai o token do link colado, `verifyPassport`, valida com `core_webservice_get_site_info`, grava o `wstoken` cifrado) |

### Google: dois apps OAuth

- **Interno** (`GOOGLE_CLIENT_ID/SECRET`, projeto `ufba-platform`, app **Interno** da organização ufba.br): login E Classroom das contas @ufba.br. Redirect `<PUBLIC_URL>/oauth/callback/google` (com usuário identificado = conexão do Classroom; sem = login). Apps internos não passam por verificação, então `drive.readonly` vale sem auditoria. No console: APIs do Classroom e do Drive ativadas; escopos do Classroom + `drive.readonly` em Acesso a dados.
- **Convidados** (`GOOGLE_CLASSROOM_CLIENT_ID/SECRET`, projeto separado, app **Externo**): turmas em gmail pessoal. Redirect `<PUBLIC_URL>/oauth/callback/classroom`. Fica em **Testando** de propósito:
  - `drive.readonly` é escopo **restrito** (público exigiria verificação + auditoria CASA anual);
  - só os usuários de teste (até **100 no ciclo de vida do projeto**, não dá para zerar) conseguem conectar;
  - o acesso expira em **7 dias** (a conta vira "reconectar" e a pessoa conecta de novo).
- O Classroom é lido pelo app que emitiu o token, escolhido pelo domínio do e-mail (`appDaConta`). Uma conta @ufba.br não conecta pelo app de convidados, nem o contrário.
- **Trava do `drive.readonly`**: o `ref` de um anexo do Classroom é `<curso>:<t|m|a>:<post>:<arquivo>`; `baixar` busca o post e só lê do Drive se o arquivo estiver anexado nele.
- Avaliado e descartado: Picker com `drive.file` (escopo não sensível, mas exige escolher os arquivos numa janela do Google a cada grupo de downloads; protótipo funcionou, UX ruim).

Os dois clientes são do tipo **Aplicativo da Web** (o tipo Desktop de `docs/GOOGLE.md` serve só ao script de refresh token).

### Moodle

O login acontece no navegador da pessoa; o servidor nunca vê a senha. O `launch.php` usa `urlscheme=web+ufba` (o AVA aceita); o app web registra a si mesmo como tratador desse esquema (`navigator.registerProtocolHandler`), recebe o link e o envia para `POST /connections/moodle` (ver docs/WEB-API.md). Com `moodlemobile://`, no Windows o token ia para o diálogo "Obter um aplicativo" e se perdia. `MOODLE_SITE_URL` (padrão `https://ava.ufba.br`), `MOODLE_URL_SCHEME` (padrão `web+ufba`). O AVA não envia o intermediário TLS; ele fica em `certs/` (ver `src/infrastructure/tls/extra-ca.ts`).

### Outras decisões

- Os testes do transporte usam `src/interface/mcp/testing/` (stubs e memória), que nunca entra no `AppModule`.
