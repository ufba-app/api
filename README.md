# ufba-app/platform

Serviço aberto que reúne, num só lugar, os dados acadêmicos de quem estuda na UFBA: **SIGAA**, **Moodle**, **Google Classroom** e **Google Calendar**. Expõe tudo por duas interfaces equivalentes, **REST** e **MCP**, sobre os mesmos casos de uso.

> Estado: início do projeto. Ainda não há funcionalidade; o que existe é a arquitetura. Veja [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Princípios

- **O servidor sozinho não abre a senha do SIGAA.** O SIGAA não tem API, então o acesso é feito como um navegador faria, com login e senha. A senha fica cifrada com uma chave que só existe no token de cada cliente (o banco guarda o cifrado e o hash do token). Na consulta, é aberta em memória, usada e descartada. Tokens de fontes com API oficial (Moodle, Google) ficam guardados, cifrados.
- **Leitura ao vivo.** Nada é sincronizado nem copiado das fontes: cada consulta vai à fonte na hora, em nome da pessoa.
- **Senha nunca em log.** A senha circula como `Secret`, que vira `[redacted]` se for impresso, serializado ou inspecionado. Um teste "canário" (`test/secret-canary.spec.ts` e o fim de `test/web-api.spec.ts`) roda os fluxos com uma senha marcada e falha se ela aparecer em qualquer saída.
- **Código aberto de propósito.** Quem usa pode ler o que acontece com os próprios dados.

## Contribuindo

A `main` é protegida: toda mudança entra por branch e pull request. Antes de abrir o PR, `npm run build` e `npm test` precisam passar. A regra de dependência entre camadas é verificada por teste (`test/architecture.spec.ts`).

Credenciais (senha do SIGAA, tokens, a chave K, cookies de sessão) nunca vão para log, mensagem de erro ou resposta. Não logue corpo de requisição. Senha nova entra no código já como `Secret.of(...)`, e `reveal()` só é chamado onde o valor sai de fato (o login no SIGAA e a cifragem). Os testes canário garantem isso: se um deles quebrar, o problema é o log, não o teste.

## Licença

[AGPL-3.0](LICENSE). Quem hospedar uma versão modificada precisa publicar o código dela.
