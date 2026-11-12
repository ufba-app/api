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
| `prazos()` | Próximos prazos das matérias atuais. Ponto de partida para "o que tenho para hoje" | 1 (calendário) | 1 + 1 por matéria ativa, até 15 (a API não tem calendário agregado) | 1 + 2 por turma, até 8 turmas (portal + entrar na turma + avaliações); só avaliações de hoje em diante |
| `ver_curso(cursoId)` | Tarefas (descrição + prazo), materiais, avisos, provas e fóruns de **uma** matéria | 2 | 3 | 5 (portal, entrar na turma, notícias, avaliações, tópicos de aula) |
| `ver_forum(forumId)` | Discussões de **um** fórum do Moodle (inclui o de avisos) | 1 | não existe | ainda sem suporte |
| `ver_aviso(avisoId)` | Texto completo de **um** aviso/notícia (`id` de um item `tipo: aviso` de `ver_curso`) | não existe | não existe | 4 (portal, entrar na turma, lista de notícias, clique "Visualizar"; POST direto em `mostrar.jsf` volta sem a notícia) |
| `baixar_anexo(ref \| anexos[])` | Links de download temporários (uso único, ~10 min) + comandos `curl` prontos. O arquivo é buscado quando o link é usado | 0 (+1 por download) | 0 (+3 por download: confere o anexo no post, metadados e conteúdo do Drive) | ainda sem suporte |

No Classroom, a renovação do access token (cache em memória) é uma chamada extra no máximo a cada hora. No SIGAA, o login (4 requisições) só acontece quando não há sessão em memória para aquela pessoa+cliente, ou ela passou de 20 min sem uso; as requisições de uma mesma sessão são sempre em sequência. Os tetos são protegidos por teste (`test/mcp-integration.spec.ts` com o `MoodleLive` real; `classroom-live.spec.ts`; `sigaa-live.spec.ts`).

**Risco não validado em `prazos` do SIGAA:** para caber em 1 + 2×8, o portal é lido uma vez só. A partir da 2ª turma, o postback reaproveita o `ViewState` da última página da sessão, e não o do form do portal. Isso ainda não foi validado contra o SIGAA real. Se o SIGAA devolver o portal em vez da turma, `prazos` falha com `UNAVAILABLE` ("página inesperada"), nunca com lista parcial ou vazia. Alternativas se isso acontecer: reler o portal antes de cada turma (1 + 3×8) ou mandar o `ViewState` do próprio form do portal.

No SIGAA, `ver_curso` traz notícias como `tipo: aviso` (só o título; o texto vem de `ver_aviso`), avaliações como `tipo: prova` (prazo com a data e a hora do SIGAA, fuso da Bahia, UTC-3) e tópicos de aula como `tipo: material`. O `cursoId` é o nome da turma normalizado (ex.: `sistemas-operacionais`), como vem de `listar_cursos`.

**Várias contas na mesma fonte** (ex.: Classroom no gmail pessoal e no @ufba.br): o cliente escolhe. `listar_contas` mostra as contas; as outras ferramentas recebem `conta` e leem só ela. Sem `conta`, vale a única conta da fonte; com mais de uma, a ferramenta responde com erro listando as contas (sem chamar a fonte). Para ler todas, o cliente consulta uma por vez. Os links de `baixar_anexo` guardam a conta de origem.

**Download:** `GET /download/:id`. O id (aleatório, uso único, ~10 min) é a própria credencial, sem Bearer, para funcionar com `curl`/navegador na máquina da pessoa. Os links ficam só em memória (morrem ao reiniciar; não valem entre instâncias).

**Segredos não passam por ferramentas.** Tokens do Moodle e do Google e a senha do SIGAA entram só pela tela de autorização; nenhuma ferramenta aceita senha ou token.

**Removido (04/11/2026):** `sincronizar`, `listar_itens`, `agenda`, `mudancas`, `perfil`, `historico`, `insights`, `importar_historico`, `ler_anexo` e as rotas REST equivalentes, junto com o motor de sincronização e o histórico. As tabelas do banco continuam no esquema, sem uso.

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
4. Em cada consulta com `fonte: sigaa`, o `ConsultaService` separa K do token, abre a senha **em memória**, e o `SigaaLive` usa a sessão do SIGAA daquela pessoa+cliente (`SessoesSigaa`: em memória, 20 min sem uso; o login só acontece quando não há sessão). Senha recusada pelo SIGAA marca a credencial como `REAUTH_NEEDED` (`listar_contas` mostra `status: reconectar`); a pessoa conecta de novo na tela de autorização.
5. Sem K (chave de API `plt_`, ou token emitido sem SIGAA conectado), as ferramentas com `fonte: sigaa` respondem "SIGAA não conectado" **sem nenhuma requisição ao SIGAA** (testado em `test/mcp-integration.spec.ts`).

**O que o banco guarda** (`sigaa_credentials`, uma linha por pessoa + cliente OAuth): `user_id`, `client_id`, `login`, a senha cifrada (`secret_ciphertext`, `secret_iv`, `secret_auth_tag`) e `status`. **Não** guarda K, a senha em claro, nem o JSESSIONID. Os tokens OAuth são guardados só como hash SHA-256 (do token inteiro, com K), então o banco sozinho não abre a senha. A conta do SIGAA em `source_accounts` nunca guarda segredo. Cada cliente autorizado tem a sua K e a sua linha.

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
| Leitura do SIGAA | `SigaaLive` (`src/infrastructure/sources/sigaa/sigaa-live.ts`) com os parsers da turma virtual copiados do ufba-app (`sigaa/turma-virtual/`) e `SessoesSigaa` (sessões em memória por pessoa+cliente) |
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
