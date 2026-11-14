# Deploy no Railway (produção)

Só produção. Projeto **ufba-app** (workspace Espectro Tech). A API fica em `https://api.ufba.app` e o web em
`https://meu.ufba.app` (a landing `https://ufba.app` virá depois), cada um num serviço próprio. Nunca use os domínios `*.up.railway.app` para o login: eles estão na
Public Suffix List e o cookie de sessão não funciona entre eles.

## Serviços

| serviço | repo | domínio |
|---|---|---|
| Postgres | plugin do Railway | interno |
| API | `ufba-app/platform` (este) | `api.ufba.app` |
| Web | `ufba-app/web` | `meu.ufba.app` |

A API builda pelo `Dockerfile` (ver `railway.json`). No start, roda `prisma migrate deploy` e depois sobe. Se a
migração falhar, o container não sobe e o deploy anterior continua no ar. Healthcheck: `GET /health`.

## Variáveis da API

| var | valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referência ao plugin) |
| `SECRETS_KEY` | 32 bytes em base64 (`openssl rand -base64 32`). **Não troque depois**: cifra os tokens do Moodle e do Google já guardados |
| `PUBLIC_URL` | `https://api.ufba.app` |
| `WEB_ORIGIN` | `https://meu.ufba.app` (painel). Aceita **lista separada por vírgula** para a transição entre domínios, ex.: `https://meu.ufba.app,https://ufba.app`; a **primeira é a principal** (ver abaixo) |
| `AUTH_ORIGIN` | `https://auth.ufba.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | app interno (login @ufba.br + Classroom @ufba.br) |
| `GOOGLE_ALLOWED_DOMAIN` | `ufba.br` |
| `GOOGLE_CLASSROOM_CLIENT_ID`, `GOOGLE_CLASSROOM_CLIENT_SECRET` | opcional: Classroom de convidados (gmail) |

`HOST=0.0.0.0` e `PORT` já vêm do Dockerfile (o Railway injeta `PORT`). Não defina `SIGNUP_TOKEN` em
produção, a menos que precise. Com `NODE_ENV=production` (já no Dockerfile), a API não sobe sem `WEB_ORIGIN` e
`PUBLIC_URL`. No boot, `WEB_ORIGIN` e `AUTH_ORIGIN` são validados: só origem (esquema + host), sem barra final, sem curinga, `https` em produção; `AUTH_ORIGIN` é uma origem só.

## Google Cloud (antes do primeiro login)

No cliente OAuth do app interno, acrescente em **URIs de redirecionamento autorizados**:

- `https://api.ufba.app/oauth/callback/google`

No app de convidados (se usar): `https://api.ufba.app/oauth/callback/classroom`.

## DNS

No Railway, em cada serviço → Settings → Networking → Custom Domain: `api.ufba.app` na API e `ufba.app` no web. O
Railway mostra o registro CNAME a criar no DNS do domínio.

## Checklist depois do deploy

1. `https://api.ufba.app/health` → `{"status":"ok"}`.
2. Log do start mostra `[web] painel <origem principal> (origens aceitas: …), auth <origem>`.
3. `https://api.ufba.app/.well-known/oauth-authorization-server` mostra `issuer: https://api.ufba.app`.
4. Entrar pelo web (a origem principal do painel) com a conta @ufba.br.
5. Conectar o Claude: URL do conector MCP = `https://api.ufba.app/mcp`.

## Banco existente

O Postgres de produção começa vazio: as migrações criam tudo. Os tokens e conexões do banco de desenvolvimento não
são migrados (cada pessoa conecta de novo).

## Transição de domínio do painel (`ufba.app` → `meu.ufba.app`)

`WEB_ORIGIN` aceita mais de uma origem separada por vírgula. Durante a migração, use
`WEB_ORIGIN=https://meu.ufba.app,https://ufba.app`; depois que terminar, deixe só `https://meu.ufba.app`.

- A **primeira** é a principal: é para ela que a API redireciona o navegador (ex.: volta do Classroom para
  `/connections`) e ela é o `AUTH_ORIGIN` quando este não está definido.
- **Todas** entram no CORS (com cookie) e na checagem de `Origin` do CSRF.
- `AUTH_ORIGIN` segue único (`redirect_uri` do cliente `ufba-web` e telas de `/authorize`).
- O cookie de sessão vale para os dois painéis: ele é da API (`api.ufba.app`) e todos os hosts estão no mesmo site
  (`ufba.app`), então `SameSite=Lax` continua funcionando.
- Trocar a ordem ou a lista só exige reiniciar (redeploy) a API. Os callbacks do Google (em `api.ufba.app`) não mudam.
