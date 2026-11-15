# Currículo como grafo (desenho)

**Estado:** desenho em conversa com o André. **Primeira fatia implementada** na branch `feat/curriculo-grafo-cache` (a pedido do André): construtor do grafo com arestas tipadas (`src/domain/academic/curriculum-graph.ts`) e cache (`src/application/academic/curriculum-graph-cache.ts`). Ainda sem rota, sem contrato e sem ligar ao `app.module`; o resto do desenho (caminho, cadeia, simulação) depende das perguntas da seção 9. Sem migração e sem PR. Nenhuma requisição ao SIGAA foi feita; tudo vem da leitura do código desta API e do repositório público do ai-memory.

## 1. Decisão

**Não remontar o modelo do banco.** O grafo vira um **módulo de domínio em TypeScript** que lê as expressões que já guardamos (`prerequisiteExpr`, `corequisiteExpr`, `equivalenceExpr`), mais um **cache do grafo por currículo** em memória. Sem tabela nova, sem migração. A tabela de arestas (opção C) fica **arquivada** até aparecer um dos gatilhos da seção 7.

Caso de uso que motiva: a tela "Linha de chegada" do painel (grade por semestre com linhas entre matérias; ao clicar numa matéria, o caminho **inteiro** antes e depois; "libera", "segura", "mais atrasa a conclusão"; "conclui em 2028.2"; plano do próximo semestre com "libera se passar em X").

## 2. Por que não banco

- **ai-memory** (lido em `crates/ai-memory-store`): o grafo é uma tabela `links` (`from_page_id`, `to_page_id`, `link_type`, escopo) consultada por `JOIN` em um passo, nos dois sentidos, sem extensão e sem CTE recursiva. O markdown é a fonte e o SQLite é índice reconstruível. `WITH RECURSIVE` só aparece nas cadeias de substituição de página.
- **Volume pequeno:** um currículo Ativo por curso, dezenas de componentes. Cabe inteiro na memória, e a rota da grade já o carrega inteiro.
- **O SQL não avalia E/OU aninhado.** A lógica booleana fica no domínio de qualquer jeito, então guardar a árvore em tabelas não simplifica a leitura.
- **Sob carga**, uma consulta recursiva por clique pressiona o Postgres; um cache em memória tira o banco do caminho.
- **Descartadas:** Apache AGE (extensão que a Railway gerenciada talvez não ofereça; a confirmar), `ltree` (modela árvore, currículo é DAG), banco de grafos à parte.

## 3. Modelo de hoje (não muda)

- `prisma/models/catalog/curriculum-component.prisma`: um componente por linha, único por `(curriculumId, code)`, com os três textos e `responsibleUnit`. Vêm das páginas públicas do SIGAA.
- Formato: `( FISD36 E FISD42 ) OU ( ENGJ18 )`, parênteses aninhados e duplos, `E` antes de `OU`, códigos como `ENG295A` e `GENG0091`.
- `src/domain/academic/prerequisite.ts`: `citedCodes`, `checkExpression` → `MET | NOT_MET | UNKNOWN` (falha fechado: texto sem código, como carga mínima, ou malformado, é `UNKNOWN`).
- `src/domain/academic/progress.ts` (`buildProgress`): equivalência **direcional e do currículo Ativo** (`equivalenceExpr` de X: "X está cumprido se esta expressão for atendida"), aplicada em ponto fixo; mais as linhas "Cumpriu A através de B" do histórico (por aluno, fora do catálogo). Co-requisito só é exibido.

## 4. O módulo de grafo

Novo arquivo de domínio (nome sugerido: `src/domain/academic/curriculum-graph.ts`, com spec ao lado), puro, sem rede, no padrão de `progress.ts`. Reaproveita o parser de `prerequisite.ts` (o `Expr` hoje é interno: expor o AST é parte do trabalho).

**Construção.** Para cada componente, o parser gera a árvore da expressão. A partir dela, cada código citado vira uma aresta `prerequisito → componente` com um **tipo**:
- `REQUIRED` (linha contínua): o código é exigido em toda forma de satisfazer a expressão. Vem de `E`, ou de um `OU` com uma só alternativa.
- `ALTERNATIVE` (tracejada): o código está em um `OU`; basta uma das alternativas.

Regra (implementada): `REQUIRED` = código exigido em toda forma de satisfazer a expressão (`E` une os conjuntos, `OU` interseciona, recursivo, então vale também para `OU` aninhado). Qualquer outro é `ALTERNATIVE`. Co-requisito e equivalência usam a mesma regra, em relações próprias. O `alt_group` (para a tela dizer "uma destas") **não foi implementado** nesta fatia: entra junto com o contrato.

**Consultas** (todas em memória sobre o currículo carregado):

| Pergunta | Cálculo |
|---|---|
| Libera X | Quem cita X no pré-requisito (um passo para frente) |
| Caminho inteiro de X | Fecho transitivo para trás (antes) e para frente (depois), marcando cada nó cumprido ou não |
| Segura | Descendentes alcançáveis por arestas `REQUIRED` |
| Mais atrasa a conclusão | Maior cadeia até o fim entre os obrigatórios faltantes (cada `OU` escolhe a alternativa mais curta); quem fica em cadeias mais longas "atrasa mais" |
| Libera se passar em X | `checkExpression` com `done ∪ {X}`, listando o que passa a `MET` |
| Conclui em AAAA.S | Simulação semestre a semestre: a cada passo, os disponíveis entram até o teto de horas; repete até acabar |

**Ressalvas que a tela precisa mostrar** (já é estimativa, e continua):
1. **Oferta.** Não sabemos em que semestres cada matéria é ofertada: a projeção assume que tudo é oferecido sempre. É a ressalva mais forte.
2. **`OU`.** "Segura" só vale pelas arestas `REQUIRED`.
3. **Pré-requisito sem código** (carga mínima): hoje `UNKNOWN`; na simulação, tratar como não bloqueante com aviso, ou bloqueante? **Decisão do André.**
4. **Co-requisito:** hoje só exibido; para a simulação, ele entra no mesmo semestre. **Decisão do André** (muda o significado de `AVAILABLE`).
5. **Ciclo** (expressão mal importada): o módulo detecta e ignora a aresta, com aviso, sem travar.

## 5. Cache

- Chave: id do currículo; versão: `fetchedAt` do `Curriculum`.
- Guarda o grafo montado (matérias, arestas tipadas, índices de entrada e saída), **sem dado de pessoa**. O histórico do aluno entra só no cálculo, nunca no cache.
- Renovação (implementada): dentro do prazo (5 min) não toca no banco; passado o prazo, lê só a linha do currículo e compara a versão (`sigaaId:fetchedAt`): igual renova o prazo, diferente lê os componentes e remonta. Montagens simultâneas do mesmo curso viram uma só; erro do banco não fica guardado; `invalidate()` força remontar. Limite conhecido: a importação pode trocar o currículo entre a leitura da linha e a dos componentes; a versão fica atrás por até um prazo e se corrige na conferência seguinte.
- Cada instância na Railway tem o seu cache; o dado é pequeno e igual em todas.
- **Não foi medido sob carga.** Antes de contar com ele, teste de carga. Os gargalos prováveis estão fora do grafo (leitura ao vivo do SIGAA, leitura do histórico pela IA).

## 6. Contrato

Campos novos em `GET /me/academic/curriculum` (nomes provisórios, em inglês; textos para pessoas em pt-BR):
- Por componente: `unlocks` (códigos liberados diretamente), `blocks` (os que segura, pelas arestas `REQUIRED`), `criticality` (posição na maior cadeia).
- Lista de arestas: `{ from, to, kind: REQUIRED | ALTERNATIVE, group }`, para as linhas da grade.
- Caminho de uma matéria: ou campo por componente (`path.before`, `path.after`) ou rota própria `GET /me/academic/curriculum/:code/path`; preferir o campo, para evitar um round-trip por clique (o grafo cabe na resposta).
- `projection`: `{ completionTerm, semestersLeft, hoursPerTerm, assumption: "OFFER_ALWAYS" }`, sempre com `estimate: true`.
- Rota ou parâmetro para "libera se passar em X" (plano do semestre).

Cada campo novo entra em `contract.ts` (Zod) e na tabela `ROUTES` do gerador; `API_ERROR_CODES` só se houver código de erro novo. Depois: `npm run openapi`, commit do `openapi.json` e **aviso ao Mosaico**. Ajuste de docs: `docs/WEB-API.md` 5.1.

## 7. Quando reabrir a tabela de arestas (opção C)

Só se aparecer um destes casos:
1. Pergunta que cruza cursos ou currículos ("em quais cursos X é pré-requisito de algo?").
2. Consulta sem aluno nem grade (ferramenta do MCP, página pública) em volume que justifique não carregar o currículo.
3. Desempenho medido ruim mesmo com o cache.
4. Necessidade de auditar as expressões que viraram `UNKNOWN`.

A migração seria aditiva e reversível, preenchida do texto já gravado, sem SIGAA.

## 8. Mescla do histórico com o currículo novo

Não muda. A ponte continua sendo `equivalenceExpr` do Ativo (direcional, em ponto fixo) mais as equivalências do próprio histórico. Dois ganhos possíveis, fora deste desenho, cada um com OK do André:
- Importar também os currículos antigos do SIGAA público (exige OK antes de qualquer requisição).
- Aprender pares de equivalência a partir de históricos confirmados, só com pares de códigos que apareçam em vários históricos, sem nada da pessoa.

## 9. Perguntas abertas (para o André)

1. Pré-requisito sem código (carga mínima): bloqueante ou não na simulação? (seção 4, ressalva 3)
2. Co-requisito: passa a ser calculado (mesmo semestre)? (ressalva 4)
3. A projeção "conclui em" pode sair sem saber a oferta por semestre, com o texto de estimativa? (ressalva 1)
4. Campo de caminho por componente ou rota por matéria? (seção 6)
5. Quantas matérias há hoje na base (contagem simples, sem ir ao SIGAA)? Só para dimensionar o tamanho da resposta com o caminho embutido.

## 10. Não-objetivos

Mudar o modelo do banco; trazer banco de grafos; substituir o avaliador atual; guardar dado pessoal no cache ou no grafo (equivalência por aluno fica no histórico).
