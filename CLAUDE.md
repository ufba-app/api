# CLAUDE.md: como trabalhar no `ufba-app/api`

Backend único do ufba.app: NestJS 11 + Prisma 7 + Postgres, AGPL-3.0. Faz quatro coisas: servidor **OAuth 2.1**, servidor **MCP** (`/mcp`), **API JSON** do app web (repo `ufba-app/web`) e **leitura ao vivo** de SIGAA, Moodle (AVA) e Google Classroom em nome do aluno. Produção: `https://api.ufba.app` (Railway). Painel: `https://ufba.app`; telas de login e autorização: `https://auth.ufba.app`.

Leia antes de mexer: `README.md`, `docs/ARQUITETURA.md`, `docs/WEB-API.md` (fluxos e regras), `openapi.json` (formatos), `docs/MCP.md`, `docs/MOODLE.md`, `docs/GOOGLE.md`, `docs/DEPLOY.md`. Desenhos em `docs/specs/` (memória compartilhada: `2026-11-14-memoria-ufba.md`).

## Regras do André (valem sempre)

- **Segredos:** nunca ler, imprimir ou manusear senhas, tokens ou segredos. Não imprima valores do `.env` (só nomes das variáveis). Credenciais nunca vão para log, erro ou resposta.
- **Fontes reais (SIGAA, AVA, Google):** peça OK antes de qualquer teste contra elas. Nada de varrer cursos em massa nem sincronizar em massa.
- **Git:** commit em branch. Push, PR e merge só quando o orquestrador ou o André pedirem. Na `main`, só via PR com o CI verde **antes** do merge. Commits terminam com a linha `Co-Authored-By` indicada pelo ambiente. Não troque de branch na pasta principal se outro agente usa worktree.
- **Deploy:** o Railway publica a `main` sozinho. Só produção, sem ambiente de dev. Railway: só leitura (status, deploys, logs) a menos que peçam; não tente listar variáveis do serviço.
- **Servidores:** não reinicie servidor nem suba a API local sem pedido.
- **Maestri:** não apague nota nem feche portal sem pedido.
- **Nomes:** identificadores de código e API em **inglês**; textos para a pessoa (UI e `message`) em **pt-BR**.
- **Respostas:** diretas, recomendação primeiro, ressalvas agrupadas pela causa. Não varrer pastas fora do projeto.
- **Vínculo:** para trocar o SIGAA ou o AVA ligados, a pessoa exclui a conta (`DELETE /me`) e entra de novo; não existe "trocar".
- **Relatório:** ao terminar tarefa do orquestrador (`Claude Code - ME #3`), responda com `maestri ask "Claude Code - ME #3" "<resultado>"`.

## Comandos

O Node 22 vem do WinGet. O "é" do nome do usuário no PATH quebra a resolução; no Git Bash faça antes:

```bash
export PATH="$(ls -d /c/Users/AndréLuizdeOliveiraJ/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.22*/node-v*/ | head -1):$PATH"
```

Não há Python nem Docker na máquina.

```bash
npm run build                  # prisma generate + nest build
npm test                       # jest, sem rede
npx tsc --noEmit -p tsconfig.json
npm run openapi                # regrava openapi.json (precisa do prisma client gerado)
```

Antes de dizer "pronto": `npm run build`, `npm test` e `tsc` verdes. Testes nunca usam rede.

**Migrações.** O banco de dev é `platform_dev` no Postgres da máquina espectro (`192.168.1.210:5436`); a URL está no `.env` (gitignored).

```bash
mkdir prisma/migrations/<timestamp>_<nome>
npx prisma migrate diff --from-config-datasource --to-schema prisma --script > prisma/migrations/<timestamp>_<nome>/migration.sql
npx prisma migrate deploy
```

O schema é dividido em `prisma/models/<grupo>/*.prisma`. O container (`Dockerfile`) roda `prisma migrate deploy` no start, então migração entra sozinha no deploy. Healthcheck em `/health`.

**Subir local** (só quando pedirem; o `main.ts` não carrega `.env`):

```bash
npm run build
WEB_ORIGIN=http://localhost:3001 AUTH_ORIGIN=http://localhost:3002 PUBLIC_URL=http://localhost:3000 PORT=3000 \
  node --env-file=.env dist/src/main.js
```

Variáveis (só os nomes): `PORT`, `DATABASE_URL`, `SECRETS_KEY`, `SIGNUP_TOKEN`, `PUBLIC_URL`, `WEB_ORIGIN`, `AUTH_ORIGIN`, `HOST`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAIN`, `GOOGLE_CLASSROOM_CLIENT_ID`, `GOOGLE_CLASSROOM_CLIENT_SECRET`, `MOODLE_SITE_URL`, `MOODLE_URL_SCHEME`, `ADMIN_EMAILS` (administradores: memória e alertas do calendário; sem alternativa), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (Web Push; o André gera e configura, a privada nunca é impressa; sem as três o canal fica desligado e as rotas dão 503 `push_unavailable`; só na API e no `notify-cron`, `docs/NOTIFICACOES.md`), `ANTHROPIC_API_KEY` (leitura do histórico e do calendário pela IA, Haiku 5.5 fixo; sem ela a leitura não existe; o cron do calendário é um serviço à parte, `docs/CALENDARIO-CRON.md`). Em produção o boot exige `WEB_ORIGIN` e `PUBLIC_URL`. `WEB_ORIGIN` aceita lista separada por vírgula (a primeira é a principal, usada nos redirects para o painel; todas valem para CORS e CSRF); `AUTH_ORIGIN` é único; ambos são validados no boot (https em produção, sem barra final, sem curinga).

## Camadas

`domain` ← `application` ← `interface`; a `infrastructure` implementa as portas. `test/architecture.spec.ts` quebra o build se a regra for violada. Controllers finos; um caso de uso por responsabilidade (`application/web/`: `WebSessionService`, `ConnectionsService`, `AuthorizationRequests`, `AuthorizedApps`, `ConnectionStatus`).

**Sem telas no backend:** só JSON e os redirecionamentos do OAuth. Login, consentimento, conexões e capturas são do web. O `oauth.controller` tem só `.well-known/*`, `POST /register`, `GET /authorize`, `/oauth/callback/google|classroom` e `POST /token`. O cliente da casa é `ufba-web`, criado no boot.

**Leitura ao vivo:** cada consulta vai à fonte na hora; nada do conteúdo é copiado. As tabelas de `catalog/academic/coursework/sync` são da era da sincronização e não são gravadas. Exceção: o SIASB é sincronizado para `siasb_*` por um cron do Railway (`docs/SIASB-CRON.md`); ver `docs/SIASB.md`.

## Segurança

- **`Secret`** (`src/application/shared/secret.ts`): senha e tokens circulam como `Secret.of(...)`, que vira `[redacted]` em `toString`, `toJSON` e `inspect`. `reveal()` só onde o valor sai de fato (requisição à fonte e cifragem). Nunca logue corpo de requisição. Os testes canário (`test/secret-canary.spec.ts` e o fim de `test/web-api.spec.ts`) quebram se um segredo aparecer em qualquer saída; se um deles quebrar, o problema é o log, não o teste.
- **Senha do SIGAA:** cifrada com uma chave K que só existe dentro do token OAuth de cada cliente (`<random>.<K>`); o banco guarda o cifrado e o sha256 do token. O servidor sozinho não abre a senha. Login do SIGAA é sempre o CPF (11 dígitos).
- **Moodle e Google:** tokens cifrados com `SECRETS_KEY`.
- **Vínculo fixo conta ↔ fonte** (`domain/identity/source-binding.ts`, `application/identity/source-bindings.ts`): SIGAA pelo CPF normalizado; Moodle pelo id do usuário no AVA (`auth=shibboleth` e `username@ufba.br` igual ao e-mail de login). Só o HMAC do titular é gravado (chave derivada da `SECRETS_KEY`); o CPF nunca. Erros: `source_account_taken` (409), `source_account_mismatch` (409), `source_account_not_owned` (403).
- **Origens:** CORS e checagem de `Origin` aceitam só as origens de `WEB_ORIGIN` (lista), `AUTH_ORIGIN` e `PUBLIC_URL`. Painel hoje: `https://meu.ufba.app` (transição a partir de `https://ufba.app`). Rotas com cookie que mudam estado exigem `X-UFBA: 1`, `Origin` da casa e JSON no corpo (DELETE pode ir sem corpo). Cookie `__Host-ufba_session` em https e `ufba_session` em http; painel, auth e API precisam estar no mesmo site (`ufba.app`). Nunca use `*.up.railway.app`.

## Contrato OpenAPI

`src/application/web/contract.ts` (Zod) é a fonte única: valida a entrada, dá os tipos e gera o OpenAPI. O gerador (`src/interface/web/openapi.ts`) tem a tabela `ROUTES` com `operationId`. Entrada inválida vira 400 `invalid_request` com mensagem genérica, que nunca ecoa o valor recebido. `ApiError.code` usa o enum `API_ERROR_CODES`: código novo precisa entrar no contrato.

- Mudou o contrato: rode `npm run openapi`, faça commit do `openapi.json` e **avise o agente do web (Mosaico)**.
- Rota nova em controller: atualize `ROUTES` ou a lista `OUTSIDE_CONTRACT` (MCP, OAuth, REST de chave de API, `/health`, `/openapi.json`), senão `test/openapi.spec.ts` falha.
- O gerador grava LF; o diff do CI roda em Linux (`git diff --exit-code` após regenerar).
- O CI (`.github/workflows/ci.yml`) usa Postgres 16: valida/gera Prisma, `migrate deploy`, confere `migrate diff --exit-code`, build, testes e o `openapi.json`.

## Armadilhas

- **TLS do AVA:** o `ava.ufba.br` não envia o certificado intermediário; ele fica em `certs/` e é carregado por `infrastructure/tls/extra-ca.ts`.
- **`urlscheme` do AVA:** só letras, números, `.`, `+`, `-`, sem callback https; por isso `web+ufba` (o web captura `web+ufba://token=…`).
- **Notas no AVA:** 504 em `gradereport_user_get_grade_items` em alguns cursos; o gateway trata como curso parcial.
- **Sessão do SIGAA:** sem SSO nem API; login por formulário (`logar.do`); a sessão é o cookie `JSESSIONID`, presa a um nó, expira com 25 min parada (medido). Expirada, o SIGAA responde `302` para `/sigaa/expirada.jsp`, sem corpo (o alerta é só da página que o navegador carrega). Guardamos o cookie por pessoa (`sigaa_sessions`, cifrado), com 20 min de ociosidade e uma trava por pessoa; a senha só é aberta (com a K do cliente que consulta) para logar.
- **Classroom:** a volta do Google usa `PUBLIC_URL`; no Google Cloud os redirects são `https://api.ufba.app/oauth/callback/google` (app interno) e `/oauth/callback/classroom` (convidado).
- **Logs do Prisma no Railway** aparecem com severidade "error" (é só stderr).
- **Prazos do SIGAA** (`/sources/sigaa/deadlines`) nunca foram validados contra o SIGAA real.

## Memória do projeto

Memória compartilhada do time: https://memory.ufba.app, **workspace `ufba-app`, projeto `api`** (marcador `.ai-memory.toml` na raiz, com `[capture]` ignorando `.env`). O MCP `ai-memory` vem do `.mcp.json`, que lê `AI_MEMORY_KEY` do ambiente (a chave `aim_` é gerada em `https://memory.ufba.app/manage` e nunca entra no repositório). Leia e grave nela decisões, pendências e armadilhas; sem segredos. Documentação formal vai no projeto `docs` com tag `public`, só quando pedido. O apêndice de memória na ufba.app é da agente Marginália (`dev/ufba/memory`); dúvidas de arquitetura dessa área vêm para este repo.

## Pessoas e agentes

André (dono); `Claude Code - ME #3` (orquestrador: infra, Railway, push e PR); Mosaico (app web, `ufba-app/web`); Marginália (memória, `dev/ufba/memory`). Outros agentes usam worktrees próprios.
