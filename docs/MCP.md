# Servidor MCP

O serviço expõe as mesmas operações do REST como ferramentas MCP, por **Streamable HTTP** em `POST /mcp` (sem sessão: cada requisição é independente; `GET` e `DELETE` respondem 405). O código fica em `src/interface/mcp`; as ferramentas são adaptadores finos sobre os **mesmos casos de uso** do REST (ver `ARQUITETURA.md` §2.1).

## Ferramentas

| Ferramenta | O que faz | Vai à fonte? |
|---|---|---|
| `sincronizar(fonte, alcance, cursoId?, itemId?, credencial?)` | Busca nas fontes e grava no banco. `alcance`: `tudo`, `curso` ou `item`. SIGAA: só `tudo`, com `credencial` | **Sim** (único comando) |
| `listar_itens(fonte?, cursoId?, tipo?, limite?)` | Avisos, tarefas, provas, materiais, fóruns | Não |
| `agenda(de?, ate?)` | Eventos e prazos num intervalo | Não |
| `mudancas(desde?)` | Novo / alterado / removido desde um instante (padrão: 7 dias) | Não |
| `perfil()` | Perfil acadêmico | Não |
| `historico()` | Histórico importado | Não |
| `importar_historico(usuario, senha)` | Importa o histórico pelo SIGAA (senha só em memória) + IA | **Sim** (SIGAA) |
| `insights(tipo)` | `cr`, `trajetoria` ou `pendentes` | Não |
| `ler_anexo(itemId, anexoId)` | Conteúdo do anexo, buscado sob demanda (cache curto) | Sim, só o anexo |

**Leitura não atualiza.** Toda leitura devolve `atualizadoEm`, e a descrição de cada ferramenta orienta o agente: se o dado estiver velho, chame `sincronizar` antes. Isso é protegido por teste (`src/interface/mcp/mcp.spec.ts`): nenhuma ferramenta de leitura chama o gateway de fonte nem `sincronizar`.

**Segredos não passam por ferramentas.** Tokens do Moodle e do Google entram só pela tela de autorização. A única credencial aceita numa ferramenta é a do `sincronizar` (ex.: senha do SIGAA), usada em memória e descartada.

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
| `GET`/`POST /authorize` | Tela mínima (HTML) |
| `POST /token` | `authorization_code` com **PKCE S256 obrigatório** e `refresh_token` (rotativo) |

Regras: `redirect_uri` só `https` (ou `http` em `localhost`/`127.0.0.1`) e comparada exatamente com a registrada; `code` vale uma vez e 5 minutos; access token 1 h, refresh 30 dias; tokens são guardados só como hash SHA-256.

### Tela de `/authorize`

1. **Identificação**: e-mail (cria ou reconhece o usuário). Se `OAUTH_AUTHORIZE_SECRET` estiver definida, a tela também exige essa senha de acesso. **Defina-a em qualquer deploy exposto**: sem ela, qualquer pessoa que saiba o e-mail de outra assume a conta.
2. **Conectar Google** (Classroom + Calendar).
3. **Conectar Moodle** (opcional): SSO institucional pelo `launch.php`, via `MoodleLinkPort`. **Não existe campo para colar token.**
4. **SIGAA**: nada é conectado aqui; a senha nunca é guardada.

### Variáveis de ambiente

| Variável | Uso |
|---|---|
| `PUBLIC_URL` | URL pública do serviço (atrás de proxy/TLS); sem ela, deduz da requisição |
| `OAUTH_AUTHORIZE_SECRET` | Senha de acesso exigida na tela de `/authorize` |

## Como está ligado

A composição fica em `src/mcp-wiring.ts` (raiz de `src`, a única que enxerga `interface` e `infrastructure`) e entra no `AppModule`. Não há stubs em produção:

| Peça | Implementação |
|---|---|
| Casos de uso das ferramentas | `McpUseCasesImpl` → `SincronizarService`, `LeituraService`, `HistoricoService`, `AnexoService` (os mesmos do REST) |
| Autenticação do `/mcp` e do REST | `AUTHENTICATORS` = `[IdentityService (chave plt_), OAuthAccessTokenAuthenticator]`. **Bearer ausente ou inválido → 401** (testado em `test/mcp-integration.spec.ts`) |
| OAuth (clientes, códigos, tokens) e usuários | Postgres (`PrismaOAuthStore`, `PrismaUserDirectory`; migração `20261031120000_oauth`, que só acrescenta tabelas e `users.email`) |
| Histórico | `HistoricoService.importar`: `SigaaGateway.fetchSnapshot` (PDF) → `importTranscript` (IA + validação) → `transcripts`. `insights` só lê o banco |
| `ler_anexo` | `AnexoService`: Drive (Classroom) e Moodle, com o token do próprio usuário decifrado na hora; teto de 5 MB inline |
| Vínculo Google | `GoogleOAuthLink`: OAuth com `GOOGLE_CLIENT_ID/SECRET`, grava o refresh token cifrado em `CLASSROOM` e `CALENDAR` (`IdentityService.conectarConta`) |
| Vínculo Moodle | `MoodleLink`: **só informa o status**; iniciar o vínculo responde que ainda não está disponível (ver abaixo) |

### Google

O `redirect_uri` é `<PUBLIC_URL>/oauth/callback/google` e **precisa estar cadastrado** no cliente OAuth. Esse fluxo usa o cliente do tipo **Aplicativo da Web** (o tipo Desktop de `docs/GOOGLE.md` serve só ao script de refresh token). Sem `GOOGLE_CLIENT_ID/SECRET`, o botão "Conectar Google" mostra o erro na própria tela e a autorização segue.

### Moodle: pendente

O SSO pelo servidor (`docs/MOODLE.md`, Spike 2) **ainda não foi executado contra o AVA real**, e o redirect `https://` (Spike 1) foi descartado. Por isso "Conectar Moodle" não conecta nada hoje e **não existe campo para colar token**. Quando o spike validar o fluxo, basta implementar `MoodleLinkPort.startUrl/handleReturn` em `MoodleLink`; a tela e as rotas (`/oauth/connect/moodle`, `/oauth/return/moodle`) já existem.

### Outras decisões

- `GET /insights?tipo=` e `POST /historico/importar` existem no REST para manter a paridade com o MCP.
- `listar_itens` agora devolve `attachments` (id, nome, tipo, tamanho) de cada item, que são os ids de `ler_anexo`.
- Os testes do transporte usam `src/interface/mcp/testing/` (stubs e memória), que nunca entra no `AppModule`.
