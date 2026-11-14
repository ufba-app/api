# Arquitetura em camadas (inspirada em DDD)

Registro das decisões de arquitetura do serviço. Explica o que foi decidido e **por quê**, o que de DDD foi adotado (e o que não foi), e o que ficou para depois.

- Decisão inicial: 2026-10-31. Revisada em 2026-11-14 (leitura ao vivo, app web separado, domínio de volta).
- Estado: SIGAA, Moodle e Classroom lidos ao vivo; servidor OAuth 2.1 e MCP; API JSON do app web; vínculo fixo da conta com o SIGAA e o AVA.

## 1. Contexto

O serviço junta dados acadêmicos de **SIGAA**, **Moodle**, **Google Classroom** e **Google Calendar** e os expõe por **REST**, **MCP** e pela **API do app web** (`docs/WEB-API.md`).

O app web (repositório `ufba-app/web`) é a única interface com telas: login, conexões, consentimento de apps e leitura. **O backend não tem tela nenhuma**: só JSON e os redirecionamentos do OAuth.

As fontes são muito diferentes. Calendar e Classroom têm API oficial. O Moodle tem API, mas o token vem de um login institucional no navegador da pessoa. O SIGAA **não tem API**: o acesso é feito como um navegador faria, com CPF e senha.

## 2. Camadas

```
src/
├── domain/           regras puras: sem banco, rede, framework nem relógio
│   ├── identity/       vínculo fixo conta ↔ titular na fonte (CPF, usuário do AVA)
│   └── oauth/          regras do cliente OAuth (nome exibível)
├── application/      casos de uso e portas
│   ├── identity/       contas conectadas, chaves de API, vínculo (SourceBindings)
│   ├── live/           leitura ao vivo nas fontes (ConsultaService)
│   ├── oauth/          servidor OAuth 2.1 e portas dos vínculos com as fontes
│   ├── sigaa/          cofre da senha do SIGAA (cifrada com a chave do cliente)
│   ├── web/            um caso de uso por responsabilidade: sessão, conexões, autorização, apps autorizados
│   ├── shared/         Secret
│   └── ports/          repositórios e gateways
├── interface/        adaptadores de entrada
│   ├── rest/           API REST (chave de API ou token OAuth)
│   ├── mcp/            ferramentas MCP e o controller do OAuth (só protocolo)
│   └── web/            API JSON do app web (cookie de sessão)
└── infrastructure/   adaptadores de saída
    ├── persistence/    Prisma
    ├── crypto/         AES-GCM, HKDF, HMAC do titular
    ├── oauth/          busca segura de metadados e logo de clientes
    └── sources/        sigaa/, moodle/, classroom/, calendar/, google/
```

| Camada | Responsabilidade | Pode depender de |
|---|---|---|
| `domain` | Regras e conceitos. Não conhece JSON, banco, fila nem HTTP | só dele mesmo |
| `application` | Casos de uso: orquestram o domínio e as portas | `domain` |
| `interface` | Traduz o mundo de fora (REST, MCP, web) para casos de uso | `application`, `domain` |
| `infrastructure` | Fala com Postgres e com as fontes | `application`, `domain` |

A regra é uma só: **a dependência aponta para dentro**. `test/architecture.spec.ts` lê os imports e **falha o build** se a regra for quebrada, ou se o `domain` importar framework, banco ou fila. `mcp-wiring.ts` e `app.module.ts`, na raiz de `src`, são a raiz de composição: ligam portas a implementações.

Divisão de trabalho num caso típico (conectar o Moodle): a `infrastructure` (`MoodleLink`) **verifica e devolve fatos** (usuário, id, método de login); o `domain` **decide** (é desta pessoa? pode ligar?); a `application` (`ConnectionsService`) **orquestra e grava**.

Acoplamento aceito: alguns serviços de `application` usam o decorator `@Injectable` do Nest. Os casos de uso novos são classes puras, ligadas na raiz de composição.

### 2.1 REST, MCP e web chamam os mesmos casos de uso

Os adaptadores de `interface` são finos: validam a entrada e chamam casos de uso. Nenhuma lógica mora em controller nem em ferramenta.

O contrato da API do web é Zod (`application/web/contract.ts`): o mesmo schema valida a entrada, dá os tipos e gera o `openapi.json` (`npm run openapi`). `test/openapi.spec.ts` falha se houver rota do Nest fora do contrato, e o CI falha se o arquivo não bater com o código.

### 2.2 Leitura ao vivo

Cada consulta vai à fonte na hora, em nome da pessoa, e devolve o que veio. **Nada do conteúdo das fontes é copiado** hoje. A sincronização e a detecção de mudança por hash (`domain/sync`) foram removidas com a leitura ao vivo.

Decidido para o MVP (12/11): o **perfil base do aluno** (matrícula, curso, nome, vindos do SIGAA) passa a ser copiado para o banco. Só entram campos que o aluno não edita no SIGAA, nunca o e-mail. É por isso que o vínculo da conta com a fonte é fixo (§2.4).

### 2.3 Credenciais

- **Senha do SIGAA:** guardada cifrada com uma chave K que só existe no token OAuth de cada cliente (o banco guarda o cifrado e o hash do token). O servidor sozinho não abre. Ver `docs/MCP.md`.
- **Tokens do Moodle e do Google:** guardados cifrados com a `SECRETS_KEY`.
- **Nunca em log:** senha e tokens circulam como `Secret` (`[redacted]` se impresso, serializado ou inspecionado) e só são revelados onde saem de fato. Testes "canário" quebram se algum aparecer em qualquer saída.

### 2.4 Vínculo fixo conta ↔ fonte

Na primeira conexão bem-sucedida, a conta do ufba.app fica ligada ao titular na fonte, nos dois sentidos (`domain/identity/source-binding`):

- **SIGAA:** o CPF (normalizado). Não há dado não editável que ligue o SIGAA ao Google; o e-mail do SIGAA é editável e não serve.
- **Moodle:** o id do usuário no AVA. Além disso, só é aceita a conta do login institucional (Shibboleth) cujo usuário é o do e-mail de login.
- O titular não entra em outra conta; a conta não troca de titular; desconectar mantém o vínculo. Para trocar, a pessoa exclui a conta (`DELETE /me`).
- Na tabela fica só o HMAC do titular (chave derivada da `SECRETS_KEY`), nunca o CPF.

## 3. Modelo de dados

O schema está em `prisma/`, dividido por grupo em `prisma/models/<grupo>/` (Prisma 7, `schema: 'prisma'`). Os identificadores são em inglês; os termos do SIGAA ficam na fronteira (no parser) e neste glossário.

```
identity/    users · api_keys · source_accounts · sigaa_credentials · source_bindings · oauth_* · student_profiles
catalog/     programs · curricula · curriculum_components          (global, público)
academic/    sections · enrollments · transcripts (+ entries, pending) · plan_items
coursework/  course_spaces · items · attachments · grade_entries · calendar_events
sync/        sync_runs · change_events
```

Em uso hoje: `identity/`. As tabelas de `catalog`, `academic`, `coursework` e `sync` vêm do desenho com sincronização e **não são gravadas** pela leitura ao vivo. Ficam até o perfil base e os dados autorais (plano, anotações) definirem o que fica; o que não servir sai numa migração.

| SIGAA (português) | Modelo |
|---|---|
| curso | `Program` |
| estrutura curricular | `Curriculum` |
| componente curricular | `CurriculumComponent` |
| turma | `Section` |
| matrícula (na turma) | `Enrollment` |
| histórico | `Transcript` (`TranscriptEntry`, `TranscriptPending`) |
| plano de curso do aluno | `PlanItem` |

### 3.1 Decisões de modelagem que continuam valendo

- **Tudo que vem das fontes pertence a uma `SourceAccount`**, nunca direto ao usuário: um aluno nunca vê o que é de outro.
- **`SourceAccount` do SIGAA nunca tem segredo** (o caso de uso rejeita): a senha mora só em `SigaaCredential`, cifrada com a K do cliente.
- **`Transcript` guarda só dado acadêmico**: sem CPF, nascimento nem nome do aluno. O histórico é extraído por IA e validado contra o próprio documento.
- **`PlanItem` é dado autoral**: não vem de fonte nenhuma e sobrevive à reimportação.

### 3.2 Banco compartilhado

O serviço pode dividir um Postgres com outro projeto usando um schema próprio (`?schema=platform` em `DATABASE_URL`, criado antes com `CREATE SCHEMA platform;`). As migrações não citam o nome do schema, então valem em qualquer um, inclusive `public`.

## 4. O que de DDD foi adotado, e o que não foi

| Conceito | Situação |
|---|---|
| Camadas e regra de dependência | **Adotado**, com teste |
| Domínio puro, testável sem infraestrutura | **Adotado** (removido com o sync em 11/2026, recriado em 14/11 com o vínculo) |
| Casos de uso nomeados, um por responsabilidade | **Adotado** (`application/web`, `application/identity`) |
| Portas e adaptadores para as fontes | **Adotado** (`application/ports`, `application/oauth/oauth-ports`) |
| Entidades com ciclo de vida, eventos de domínio | **Não adotado**: sem necessidade hoje |

## 5. Fora do escopo agora

Agendador e fila, webhooks (Calendar, Classroom), notificações. Cada um é adição, não reescrita.
