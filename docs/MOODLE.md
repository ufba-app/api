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

## Como o token é obtido

O token **nunca é colado pelo usuário** (nem entra por ferramenta MCP). O fluxo é o SSO do Moodle (`admin/tool/mobile/launch.php`), com captura automática do redirect, como no app antigo (`mobile/src/lib/moodle-auth.ts`):

1. A tela gera um `passport` novo (`newPassport`) e abre `buildLaunchUrl(siteUrl, passport, urlScheme)`.
2. A pessoa faz o login institucional (CAFe) no Moodle.
3. O Moodle redireciona para `<urlscheme>://token=<base64>`; a tela captura o redirect (`extractReturnedToken`).
4. `parseReturnedToken` decodifica `<assinatura>:::<wstoken>[:::<privatetoken>]` e `verifyPassport` confere `md5(siteUrl + passport)` **antes** de confiar no token.
5. A plataforma guarda o `wstoken` cifrado e o gateway passa a recebê-lo em `SourceContext`.

As funções são puras (`token-launch.ts`, com testes); a captura do redirect e a gravação da conta pertencem à tela e ao Núcleo.

### Dúvida em aberto do spike

O app antigo usa um esquema nativo (`ufba-app://`) capturado dentro de uma WebView. Numa **página web** isso não existe. **Não está definido** se o Moodle da UFBA aceita um redirect `https://` (para uma página nossa) em `urlscheme`, nem como a página capturaria o token. Isso precisa ser testado no AVA real antes de implementar a tela. Até lá, `buildLaunchUrl` recebe o esquema como parâmetro e nada assume a resposta.

## Testes

`moodle.spec.ts` usa `fetch` simulado: nenhum teste acessa a rede nem usa dados reais.

## Pendências

- Trocar `source-types.ts` pelos tipos da porta `SourceGateway` do Núcleo, quando existir (`application/ports/source-gateway.ts`).
- Paginação de discussões de fórum (`page`/`perpage`) e `state` de entrega das tarefas (`mod_assign_get_submission_status`) ficaram fora deste primeiro corte.
