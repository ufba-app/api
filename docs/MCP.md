# Servidor MCP

O serviço expõe as mesmas operações do REST como ferramentas MCP, por **Streamable HTTP** em `POST /mcp` (sem sessão: cada requisição é independente; `GET` e `DELETE` respondem 405). O código fica em `src/interface/mcp`; as ferramentas são adaptadores finos sobre os **mesmos casos de uso** do REST (ver `ARQUITETURA.md` §2.1).

## Ferramentas

| Ferramenta | O que faz | Vai à fonte? |
|---|---|---|
| `sincronizar(fonte, alcance, alvoId?, credencial?)` | Busca nas fontes e grava no banco. `alcance`: `tudo`, `curso` ou `item`. | **Sim** (único comando) |
| `listar_itens(fonte?, cursoId?, tipo?, limite?)` | Avisos, tarefas, provas, materiais, fóruns | Não |
| `agenda(de?, ate?)` | Eventos e prazos num intervalo | Não |
| `mudancas(desde?, fonte?)` | Novo / alterado / removido desde um instante | Não |
| `perfil()` | Perfil acadêmico | Não |
| `historico(incluirPendentes?)` | Histórico importado | Não |
| `insights(tipo)` | `cr`, `trajetoria` ou `pendentes` | Não |
| `ler_anexo(itemId, anexoId)` | Conteúdo do anexo, buscado sob demanda (cache curto) | Sim, só o anexo |

**Leitura não atualiza.** Toda leitura devolve `atualizadoEm`, e a descrição de cada ferramenta orienta o agente: se o dado estiver velho, chame `sincronizar` antes. Isso é protegido por teste (`src/interface/mcp/mcp.spec.ts`): nenhuma ferramenta de leitura chama o gateway de fonte nem `sincronizar`.

**Segredos não passam por ferramentas.** Tokens do Moodle e do Google entram só pela tela de autorização. A única credencial aceita numa ferramenta é a do `sincronizar` (ex.: senha do SIGAA), usada em memória e descartada.

## Autenticação

`Authorization: Bearer <token>`, onde o token é um destes:

1. **Access token OAuth 2.1** do próprio serviço (fluxo abaixo): o que clientes como o Claude usam.
2. **Chave de API estática** (atalho para scripts e para configurar o cliente hoje).

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

## Estado da integração

Os provedores do `McpModule` são **stubs/memória** até o Núcleo e as fontes entregarem as peças. Cada um é uma porta com um token de injeção:

| Token | Porta | Hoje | Quem entrega |
|---|---|---|---|
| `MCP_USE_CASES` | `McpUseCases` (`mcp-ports.ts`) | `StubMcpUseCases` (vazio) | Núcleo (`src/application`) |
| `MCP_AUTH` | `McpAuth` | OAuth + `StubMcpAuth` (aceita qualquer Bearer!) | Núcleo (verificador de chave de API) |
| `USER_DIRECTORY` | `UserDirectory` | em memória | Núcleo |
| `OAUTH_STORE` | `OAuthStore` | em memória (some ao reiniciar) | Núcleo (persistência) |
| `GOOGLE_LINK` | `GoogleLinkPort` | stub | Google |
| `MOODLE_LINK` | `MoodleLinkPort` | stub | Moodle (spike do redirect aberto) |

> O `StubMcpAuth` aceita qualquer Bearer não vazio. **Não exponha este serviço na rede antes de trocá-lo pelo verificador real de chave de API.**
