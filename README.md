# ufba-app/api

Backend do [ufba.app](https://ufba.app): reúne, num só lugar, os dados acadêmicos de quem estuda na UFBA (**SIGAA**, **Moodle/AVA** e **Google Classroom**) e os entrega por três portas: um servidor **OAuth 2.1**, um servidor **MCP** (para clientes como o Claude) e a **API JSON** do app web ([`ufba-app/web`](https://github.com/ufba-app/web)). Feito com NestJS, Prisma e Postgres.

> Estado: **em produção** em `https://api.ufba.app` (Railway, publicado a cada push na `main`). Login com Google @ufba.br, conexão de SIGAA, Moodle e Classroom, leitura ao vivo, vínculo fixo entre conta e fonte, contrato OpenAPI gerado do código (`openapi.json`). Próximos passos e pendências em [`docs/specs/`](docs/specs/) e no [CLAUDE.md](CLAUDE.md).

## Princípios

- **O servidor sozinho não abre a senha do SIGAA.** O SIGAA não tem API, então o acesso é feito como um navegador faria, com login e senha. A senha fica cifrada com uma chave que só existe no token de cada cliente (o banco guarda o cifrado e o hash do token). Na consulta, é aberta em memória, usada e descartada. Tokens de fontes com API oficial (Moodle, Google) ficam guardados, cifrados.
- **Leitura ao vivo.** Nada é sincronizado nem copiado das fontes: cada consulta vai à fonte na hora, em nome da pessoa.
- **Credencial nunca em log.** A senha do SIGAA e os tokens do Moodle e do Google circulam como `Secret`, que vira `[redacted]` se for impresso, serializado ou inspecionado. Testes "canário" (`test/secret-canary.spec.ts` e o fim de `test/web-api.spec.ts`) rodam os fluxos com credenciais marcadas e falham se alguma aparecer em qualquer saída.
- **Código aberto de propósito.** Quem usa pode ler o que acontece com os próprios dados.

## Documentação

[`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) (camadas) · [`docs/WEB-API.md`](docs/WEB-API.md) (fluxos da API do web) · [`openapi.json`](openapi.json) (contrato) · [`docs/MCP.md`](docs/MCP.md) · [`docs/MOODLE.md`](docs/MOODLE.md) · [`docs/GOOGLE.md`](docs/GOOGLE.md) · [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Desenvolvimento

Pasta local: `dev/ufba/api` (antes `platform`). Com Node 22:

```bash
npm install
npm run build     # prisma generate + nest build
npm test          # jest, sem rede
npm run openapi   # regrava openapi.json
```

Configuração por variáveis de ambiente (nomes em [`docs/DEPLOY.md`](docs/DEPLOY.md) e no CLAUDE.md); nunca commite um `.env`.

## Contribuindo

A `main` é protegida: toda mudança entra por branch e pull request, com o CI verde (build, testes e `openapi.json` atualizado). A regra de dependência entre camadas é verificada por teste (`test/architecture.spec.ts`). Mudou o contrato da API: regenere o `openapi.json` e avise quem cuida do web.

Credenciais (senha do SIGAA, tokens, a chave K, cookies de sessão) nunca vão para log, mensagem de erro ou resposta. Não logue corpo de requisição. Senha ou token novo entra no código já como `Secret.of(...)`, e `reveal()` só é chamado onde o valor sai de fato (a requisição à fonte e a cifragem). Os testes canário garantem isso: se um deles quebrar, o problema é o log, não o teste.

A memória compartilhada do time é https://memory.ufba.app (workspace `ufba-app`, projeto `api`). Para usar, defina `AI_MEMORY_KEY` com a sua chave `aim_` (gerada em https://memory.ufba.app/manage); o `.mcp.json` lê a variável e a chave nunca entra no repositório.

## Licença

[AGPL-3.0](LICENSE). Quem hospedar uma versão modificada precisa publicar o código dela.
