# ufba-app/platform

Serviço aberto que reúne, num só lugar, os dados acadêmicos de quem estuda na UFBA: **SIGAA**, **Moodle**, **Google Classroom** e **Google Calendar**. Expõe tudo por duas interfaces equivalentes, **REST** e **MCP**, sobre os mesmos casos de uso.

> Estado: início do projeto. Ainda não há funcionalidade; o que existe é a arquitetura. Veja [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Princípios

- **O servidor sozinho não abre a senha do SIGAA.** O SIGAA não tem API, então o acesso é feito como um navegador faria, com login e senha. A senha fica cifrada com uma chave que só existe no token de cada cliente (o banco guarda o cifrado e o hash do token). Na consulta, é aberta em memória, usada e descartada. Tokens de fontes com API oficial (Moodle, Google) ficam guardados, cifrados.
- **Leitura ao vivo.** Nada é sincronizado nem copiado das fontes: cada consulta vai à fonte na hora, em nome da pessoa.
- **Credencial nunca em log.** A senha do SIGAA e os tokens do Moodle e do Google circulam como `Secret`, que vira `[redacted]` se for impresso, serializado ou inspecionado. Testes "canário" (`test/secret-canary.spec.ts` e o fim de `test/web-api.spec.ts`) rodam os fluxos com credenciais marcadas e falham se alguma aparecer em qualquer saída.
- **Código aberto de propósito.** Quem usa pode ler o que acontece com os próprios dados.

## Contribuindo

A `main` é protegida: toda mudança entra por branch e pull request. Antes de abrir o PR, `npm run build` e `npm test` precisam passar. A regra de dependência entre camadas é verificada por teste (`test/architecture.spec.ts`).

A memória compartilhada do time é https://memory.ufba.app (workspace `ufba-app`, projeto `api`). Para usar, defina `AI_MEMORY_KEY` com a sua chave `aim_` (gerada em https://memory.ufba.app/manage); o `.mcp.json` lê a variável e a chave nunca entra no repositório.

Credenciais (senha do SIGAA, tokens, a chave K, cookies de sessão) nunca vão para log, mensagem de erro ou resposta. Não logue corpo de requisição. Senha ou token novo entra no código já como `Secret.of(...)`, e `reveal()` só é chamado onde o valor sai de fato (a requisição à fonte e a cifragem). Os testes canário garantem isso: se um deles quebrar, o problema é o log, não o teste.

## Licença

[AGPL-3.0](LICENSE). Quem hospedar uma versão modificada precisa publicar o código dela.
