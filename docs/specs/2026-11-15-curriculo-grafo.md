# Currículo como grafo (rascunho para conversa)

**Estado:** rascunho de desenho. Nada de código de produção, migração ou PR. Nenhuma requisição ao SIGAA foi feita; tudo abaixo vem da leitura do código desta API e do repositório público do ai-memory.

## 1. Recomendação (resumo)

Começar pela **opção C: tabela de arestas derivada** (`curriculum_edges`), reconstruível a partir das expressões que já guardamos. O texto continua sendo a fonte da verdade; o grafo é um índice, como o `links` do ai-memory. Nenhuma mudança no contrato do web. A lógica booleana (E/OU) continua no domínio em TypeScript. Se mais tarde fizer falta exatidão no banco, a opção A (nós de grupo) é uma evolução da C, não um recomeço.

Motivos:

1. O ai-memory não tem banco de grafos: o "grafo" é uma tabela de arestas e junções (seção 2). O Postgres faz isso sem extensão.
2. O SQL não avalia expressão booleana bem (CTE recursiva não aceita agregação no termo recursivo). A decisão "posso cursar" precisa de TS de qualquer jeito, então guardar a árvore booleana em tabelas não simplifica a leitura de hoje.
3. O volume é pequeno: um currículo Ativo por curso, dezenas de componentes por currículo. Um currículo inteiro cabe em memória; o grafo no banco serve para consultas que cruzam currículos e para "o que destrava X" sem carregar tudo.
4. Zero risco de divergência com o que o SIGAA imprime: o texto não muda e o avaliador atual (`prerequisite.ts`, `progress.ts`) segue valendo.

## 2. Como o ai-memory faz (lido no código, `crates/ai-memory-store`)

- **Fonte da verdade são arquivos markdown**; o SQLite é índice que o `reindex` reconstrói dos arquivos.
- **Arestas: uma tabela `links`** (`V01__init.sql`, ampliada em `V13__cross_project_links.sql`): `from_page_id`, `to_page_id` (nulo se não resolvido), `to_workspace`, `to_project`, `to_path`, `link_type` (padrão `references`; tipos como aresta tipada). Chave primária composta, índice parcial em `to_page_id`. Sem nós de aresta, sem tabela de propriedades.
- **Nós: a tabela `pages`**; mais `entities` + `entity_page_links` (`V38__entities.sql`), descritas no próprio arquivo como "plain noun table, not a triple store".
- **Consulta de vizinhos** (`reader.rs`, `graph_neighbors_for_project_explained`): um passo só, com `JOIN links` nos dois sentidos (saída e entrada) e `UNION ALL`, filtrando por projeto, sem extensão e **sem CTE recursiva**. Só há `WITH RECURSIVE` para cadeias de substituição de página (`ops.rs`, `reader.rs`), não para navegar o grafo. O mapa do projeto (`project_link_graph`) calcula grau por contagem de pontas.
- **A busca funde fluxos** (FTS5, entidades, vizinhos de grafo, vetor opcional) por RRF; o grafo é um dos fluxos, não o motor.
- Lição que vale para nós: grafo simples (arestas tipadas), reconstruível, consultado por junção; profundidade ficou fora do SQL.

## 3. Como o nosso modelo guarda hoje

- `prisma/models/catalog/curriculum-component.prisma`: um componente por linha, único por `(curriculumId, code)`, com **três textos**: `prerequisiteExpr`, `corequisiteExpr`, `equivalenceExpr`, mais `responsibleUnit`. O texto vem das páginas públicas do SIGAA (`sigaa-public-catalog.ts`).
- Formato: `( FISD36 E FISD42 ) OU ( ENGJ18 )`, parênteses aninhados e duplos, `E` com precedência sobre `OU`, códigos como `ENG295A` e `GENG0091`.
- `src/domain/academic/prerequisite.ts`: `citedCodes` (todos os códigos citados), `checkExpression` → `MET | NOT_MET | UNKNOWN`. `UNKNOWN` cobre texto sem código (ex.: carga horária mínima) ou malformado; **falha fechado**.
- `src/domain/academic/progress.ts` (`buildProgress`):
  - **Equivalência é direcional e vale no currículo Ativo**: `equivalenceExpr` de X diz "X está cumprido se esta expressão (em geral códigos antigos) for atendida". Roda em ponto fixo, porque uma equivalência cumprida pode satisfazer a expressão de outra.
  - Existe ainda a equivalência **por aluno**, declarada no histórico ("Cumpriu A através de B"); essa **não é do catálogo** e não entra no grafo do catálogo.
  - Pré-requisito é avaliado contra `done` (diretos + histórico + equivalências); `missingPrerequisites` usa `citedCodes`.
  - **Co-requisito só é mostrado**, o cumprimento não é calculado.
  - A leitura reversa de equivalência (`citedCodes(c.equivalenceExpr).includes(p.code)`) é uma varredura linear por pendente; no grafo vira uma consulta de entrada.
- Contrato que consome (não deve mudar no passo 1): `GET /me/academic/curriculum` (`state`, `missingPrerequisites`, `prerequisiteExpr`, `corequisiteExpr`, `equivalenceExpr`, `responsibleUnit`; `docs/WEB-API.md` 5.1) e o resumo da vida acadêmica; o MCP lê pelo mesmo caminho.

## 4. Opções para o Postgres

### A. Árvore booleana em tabelas (nós de grupo)
`curriculum_nodes` (componente, ou grupo `AND`/`OR`) e `curriculum_edges` (`parent_node`, `child_node`, `kind` = PREREQ | COREQ | EQUIV, ordem). Cada expressão vira uma árvore: raiz = componente, filhos = grupos e referências por código.
- **Prós:** semântica completa no banco (nada de reparsear); consultas exatas por estrutura; permite expandir para qualquer tipo de exigência no futuro.
- **Contras:** o que o SQL não faz bem é justamente avaliar a árvore; todo consumo ainda precisa de TS que a percorre. Duas representações para manter sincronizadas (texto e árvore). Mais migração, mais testes.

### B. Forma normal (grupos de alternativas)
`requirement_groups` (um por alternativa de nível mais alto do `OU`) e `requirement_group_members`.
- **Prós:** simples e boa para "o que falta"; consulta direta.
- **Contras:** aninhamento real (o caso `FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) )` do ENG295) exige distribuir E sobre OU, o que pode explodir e **perde o formato original**. Pior fidelidade das três.

### C. Arestas derivadas do texto (recomendada)
`curriculum_edges (curriculum_id, from_code, to_code, kind)` com `kind` PREREQ | COREQ | EQUIV, **uma linha por código citado** na expressão (o que `citedCodes` já extrai). Opcional: `group_ref` (texto curto, como o caminho da folha na árvore) para o futuro. Reconstruída por importação, na mesma transação que grava o componente. O texto segue como fonte.
- **Prós:** nenhuma mudança de contrato; avaliador atual intacto; migração aditiva e reversível (apagar a tabela e reimportar); responde "o que destrava X" e "o que depende de X" com um `JOIN`; é o mesmo desenho do ai-memory.
- **Contras:** a aresta é **superconjunto** quando há `OU` (citar não significa exigir); para "caminho crítico" e "impacto de reprovação" exato é preciso o avaliador em TS sobre o subgrafo carregado. Um terceiro armazenamento derivado para manter em dia com a importação.

### Descartadas
- **Apache AGE:** extensão do Postgres que a Railway não oferece no gerenciado (a confirmar com o orquestrador), pesada para o volume, e aberta a Cypher onde o resto da API é Prisma.
- **`ltree`:** modela **árvores**; currículo é DAG (um componente com vários pré-requisitos e vários dependentes).
- **Banco de grafos à parte:** um segundo serviço para algumas milhares de linhas.

## 5. O que fica mais fácil (com C, exatidão por TS)

| Pergunta | Como |
|---|---|
| O que posso cursar agora | Já existe (`AVAILABLE`). Não muda; o grafo só evita a leitura inteira. |
| O que destrava X | `SELECT from_code FROM curriculum_edges WHERE to_code = :x AND kind='PREREQ'`, dedupe. Resposta é "candidatos"; exato com o avaliador. |
| O que depende de X (impacto de reprovação) | Fecho transitivo por CTE recursiva (aqui ela cabe: poucos níveis, DAG) ou BFS em TS; marca os que deixam de estar `AVAILABLE`. |
| Caminho crítico até formar | Maior cadeia entre obrigatórios faltantes; cada `OU` escolhe a alternativa mais curta. Em TS sobre o currículo inteiro carregado. |
| Reverso de equivalência (hoje varredura linear) | `kind='EQUIV'` com índice em `to_code`. |

## 6. Migração e contrato

- **Passo 1 (só C):** migração aditiva (tabela nova + índices em `(curriculum_id, to_code)` e `(curriculum_id, from_code)`), preenchimento no importador do catálogo, **backfill a partir do texto já gravado** (sem SIGAA). Contrato do web igual; nada a avisar ao Mosaico.
- Rota nova só com pedido: p.ex. `GET /me/academic/curriculum/:code/unlocks`; ao entrar, `ROUTES` do `openapi.ts` e `npm run openapi`, e aviso ao Mosaico.
- Rollback: apagar a tabela; o avaliador não depende dela.

## 7. Perguntas abertas (para o André)

1. Qual consulta vale primeiro: "o que destrava X", impacto de reprovação ou caminho crítico? Define se o passo 1 já precisa de rota ou só da tabela.
2. Equivalências **entre currículos** (antigo → ativo) hoje só existem do lado do Ativo e são direcionais. Queremos guardar também currículos antigos como nós, ou o Ativo basta?
3. Co-requisito: continuar só exibindo, ou passar a calcular (`MET` no mesmo semestre)? Muda o que "AVAILABLE" significa.
4. O pré-requisito sem código (carga mínima) vira nó de um tipo próprio ou segue `UNKNOWN`?
5. Quantos componentes existem hoje na base (contagem simples, sem ir ao SIGAA)? Define se a CTE recursiva pode rodar sempre ou se pré-calculamos fechos.

## 8. Não-objetivos

Substituir o avaliador atual; trazer um banco de grafos; alterar o contrato do web no passo 1; guardar dado pessoal (equivalência por aluno fica no histórico, fora do grafo do catálogo).
