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

- Paginação de discussões de fórum (`page`/`perpage`) e `state` de entrega das tarefas (`mod_assign_get_submission_status`) ficaram fora deste primeiro corte.
