import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { CONNECT_PROMPT_NAME, CONNECT_PROMPT_TEXT } from '../../application/memory/connect-guide';
import { memoryInstructionsFor } from '../../application/memory/memory-proxy';
import { isWebChatClient } from '../../application/memory/connect-guide';
import { registerClinicaTools } from './clinica-tools';
import {
  PERMISSAO_AGENDA,
  PERMISSAO_PROCEDIMENTOS,
  registerClinicaAgendaWriteTools,
  registerClinicaProcedimentoWriteTools,
} from './clinica-write-tools';
import { McpClinica, McpMemory, McpPrincipal, McpUseCases } from './mcp-ports';
import { run } from './tool-result';

const FONTE = z
  .enum(['moodle', 'classroom', 'sigaa'])
  .optional()
  .describe(
    'De onde ler: `moodle` (padrão, AVA da UFBA), `classroom` (Google Classroom) ou `sigaa` (SIGAA da UFBA, ' +
      'conectado na tela de autorização deste aplicativo).',
  );

const CONTA = z
  .string()
  .optional()
  .describe(
    'Conta da fonte a ler (ex.: o e-mail no Classroom), como aparece em `listar_contas`. Pode omitir quando há ' +
      'uma conta só nessa fonte; com mais de uma, é obrigatória.',
  );

/**
 * Instruções do servidor, lidas pelo Claude ao conectar. Servem para ele usar o conector em QUALQUER conversa de contexto
 * acadêmico, mesmo sem a pessoa dizer "UFBA" (ex.: "amanhã tenho prova, me ajuda a estudar").
 */
export const ACADEMIC_INSTRUCTIONS =
  'Este conector dá acesso à vida acadêmica REAL da pessoa na UFBA (SIGAA, AVA/Moodle e Google Classroom). Quem o ' +
  'conectou é estudante da UFBA: use-o sempre que a conversa tocar em estudos ou faculdade, MESMO que ela não ' +
  'mencione a UFBA, o SIGAA ou o Moodle. Exemplos: prova, trabalho, entrega, prazo, aula, matéria, disciplina, ' +
  'professor, nota, falta, semestre, material, fórum, aviso, "o que tenho para hoje/amanhã/esta semana", pedir ajuda ' +
  'para estudar ou se organizar. Antes de responder de memória, consulte: comece por `listar_contas` e `prazos`, e ' +
  'use `listar_cursos` e `ver_curso` para o conteúdo da matéria (tarefas, materiais, avisos). Assim a ajuda parte do ' +
  'que a pessoa realmente tem, não de suposições. Links do Google Drive/Docs em cursos do Moodle: use `baixar_anexo` ' +
  'com a `ref` que começa com `gdrive1.` (vem em `ver_curso`/`ver_forum`); NÃO abra o link do Drive direto, ele pede ' +
  'login. Sem permissão de escrita concedida ao app, só lê: não altera nada nas fontes.';

/** Chaves de permissão que registram ferramentas de escrita. Com qualquer uma, as instruções ganham `ESCRITA_INSTRUCTIONS`. */
const CHAVES_ESCRITA = ['moodle.forum_write', 'moodle.assignment_write', PERMISSAO_AGENDA, PERMISSAO_PROCEDIMENTOS];

export const ESCRITA_INSTRUCTIONS =
  'Com permissão do app, algumas ferramentas escrevem na fonte (postar no fórum, entregar tarefa, agenda e procedimentos do SIASB): ' +
  'sempre mostre o resumo à pessoa e só confirme depois do "sim" explícito dela.';

const AO_VIVO = 'Consulta a fonte AO VIVO, em UMA conta, com o acesso que a pessoa conectou; não grava nada.';

/** Ferramentas e quantas chamadas cada uma faz à fonte (o teste garante esse teto). */
export const FERRAMENTAS = [
  'listar_contas',
  'listar_cursos',
  'prazos',
  'ver_curso',
  'ver_tarefa',
  'ver_forum',
  'ver_topico',
  'listar_alunos',
  'ver_aviso',
  'baixar_anexo',
] as const;

/**
 * Registra uma ferramenta de ESCRITA só se a pessoa ligou a permissão `key` no painel. Sem a chave a ferramenta nem existe
 * para o cliente (não aparece em `tools/list`). Ligar e desligar vale na próxima requisição.
 */
export function registerPermissionedTool(p: McpPrincipal, key: string, register: () => void): boolean {
  if (!p.permissions?.has(key)) return false;
  register();
  return true;
}

/**
 * Cria um servidor MCP para uma requisição, com ferramentas finas sobre os casos de uso. As `clinica_*` só entram
 * quando a pessoa tem conexão SIASB (`p.siasb`) e a dependência `clinica` existe.
 */
export function buildMcpServer(
  uc: McpUseCases,
  p: McpPrincipal,
  memory?: McpMemory,
  clinica?: McpClinica,
): McpServer {
  const withMemory = memory?.enabled() === true;
  const academicas = CHAVES_ESCRITA.some((k) => p.permissions?.has(k)) ? `${ACADEMIC_INSTRUCTIONS} ${ESCRITA_INSTRUCTIONS}` : ACADEMIC_INSTRUCTIONS;
  const server = new McpServer(
    { name: 'platform', title: 'UFBA: vida acadêmica', version: '0.1.0' },
    { instructions: withMemory ? `${academicas}

${memoryInstructionsFor(p.clientName)}` : academicas },
  );

  server.registerTool(
    'listar_contas',
    {
      title: 'Contas conectadas',
      annotations: { title: 'Contas conectadas', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Contas conectadas pela pessoa em cada fonte (ex.: Moodle da UFBA; Classroom no gmail pessoal e no @ufba.br). ' +
        'Use para saber o que passar em `conta` nas outras ferramentas; para ler todas, consulte uma conta por vez. ' +
        '`status: reconectar` = a fonte recusou o acesso guardado. Não consulta fonte nenhuma.',
      inputSchema: {},
    },
    () => run(() => uc.listarContas(p)),
  );

  server.registerTool(
    'listar_cursos',
    {
      title: 'Listar matérias',
      annotations: { title: 'Listar matérias', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Lista as matérias que a pessoa cursa (use sempre que ela falar de aula, prova, trabalho, disciplina ou estudo, mesmo sem citar a UFBA). Padrão: só as em andamento; `todas: true` inclui passadas e futuras). ' +
        'Use o `id` em `ver_curso`, com a mesma `fonte` e `conta`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, todas: z.boolean().optional() },
    },
    (args) => run(() => uc.listarCursos(p, args)),
  );

  server.registerTool(
    'prazos',
    {
      title: 'Próximos prazos',
      annotations: { title: 'Próximos prazos', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Próximos prazos das matérias atuais (tarefas a entregar, provas, eventos). Use quando a pessoa falar de prova, entrega, trabalho ou "o que tenho para amanhã", mesmo sem citar a UFBA. Moodle: uma consulta ao ' +
        'calendário. Classroom: uma consulta por matéria ativa (com teto). Comece por aqui para perguntas como ' +
        '"o que tenho para hoje/esta semana"; para uma visão completa, consulte cada conta de `listar_contas`. ' +
        AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA },
    },
    (args) => run(() => uc.prazos(p, args)),
  );

  server.registerTool(
    'ver_curso',
    {
      title: 'Ver matéria',
      annotations: { title: 'Ver matéria', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Conteúdo de UMA matéria (útil para estudar para uma prova): tarefas (com descrição e prazo), materiais, avisos, provas e fóruns. Moodle: anexos ' +
        'com `ref` para `baixar_anexo` e `forumId` para `ver_forum`; links do Google Drive/Docs postados pelo professor também ' +
        'viram anexos com `ref` `gdrive1.…` (Docs e Apresentações saem em PDF, Planilhas em XLSX): use `baixar_anexo` com essa `ref` e NÃO abra o link do Drive direto (ele pede login); pasta do Drive vira um anexo por arquivo de dentro (vídeo, arquivo grande e subpasta ficam em `abrirNoNavegador`). Classroom: arquivos em `abrirNoNavegador` ' +
        '(links do Drive que a pessoa abre no próprio navegador). Use o `id` de `listar_cursos` ou o `cursoId` de ' +
        '`prazos`, com a mesma `fonte` e `conta`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, cursoId: z.string() },
    },
    (args) => run(() => uc.verCurso(p, args)),
  );

  server.registerTool(
    'ver_forum',
    {
      title: 'Ver fórum',
      annotations: { title: 'Ver fórum', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Lista os TÓPICOS de UM fórum do Moodle (inclui o de avisos da matéria), com a mensagem inicial de cada um e o `id` de cada tópico. ' +
        'Para ver as respostas de um tópico (o que os colegas postaram), use `ver_topico` com esse `id`. Use o `forumId` de `ver_curso`. ' +
        '(O Classroom não tem fóruns: os avisos vêm em `ver_curso`.) ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, forumId: z.string() },
    },
    (args) => run(() => uc.verForum(p, args)),
  );

  server.registerTool(
    'ver_topico',
    {
      title: 'Ver tópico do fórum',
      annotations: { title: 'Ver tópico do fórum', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Todas as MENSAGENS de UM tópico de fórum do Moodle, com as respostas, em ordem cronológica. Cada mensagem traz `autor`, `mensagem`, ' +
        '`postId` (para responder com `postar_forum`) e `respostaA` (o `postId` da mensagem a que ela responde; ausente na inicial). ' +
        'Use o `id` de um tópico vindo de `ver_forum`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, discussaoId: z.string() },
    },
    (args) => run(() => uc.verTopico(p, args)),
  );

  server.registerTool(
    'listar_alunos',
    {
      title: 'Listar alunos da matéria',
      annotations: { title: 'Listar alunos da matéria', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Nomes dos ALUNOS de UMA matéria (o `id` de `listar_cursos`), em ordem alfabética, com o total. Só o nome: não traz e-mail nem contato. ' +
        'Professores e monitores ficam de fora. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, cursoId: z.string() },
    },
    (args) => run(() => uc.listarAlunos(p, args)),
  );

  server.registerTool(
    'ver_tarefa',
    {
      title: 'Ver tarefa',
      annotations: { title: 'Ver tarefa', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Situação de UMA tarefa do Moodle (AVA): se foi entregue (`estado`: nova, rascunho ou entregue), quando (`enviadoEm`), se foi ' +
        'enviada fora do prazo (`atrasada`), os arquivos atuais e, em `avaliacao`, se já foi avaliada, a `nota` (como o AVA mostra, ' +
        'ex.: "100,00 / 100,00") e os `comentarios` do professor. Sem nota ainda: `avaliada: false` (não é zero). Use para "entreguei?", ' +
        '"qual foi a minha nota?" e "o que o professor comentou?". `tarefaId` é o `id` da atividade `tipo: tarefa` em `ver_curso`. ' +
        'Só lê; para entregar, use `preparar_envio_tarefa` (exige permissão de escrita). Moodle: 2 chamadas. ' + AO_VIVO,
      inputSchema: TAREFA,
    },
    (args) => run(() => uc.verTarefa(p, args)),
  );

  server.registerTool(
    'ver_aviso',
    {
      title: 'Ver aviso',
      annotations: { title: 'Ver aviso', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Texto completo de UM aviso/notícia de uma matéria. Hoje só no SIGAA (`fonte: sigaa`). Use o `id` de um ' +
        'item `tipo: aviso` vindo de `ver_curso`, com a mesma `fonte` e `conta`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, avisoId: z.string() },
    },
    (args) => run(() => uc.verAviso(p, args)),
  );

  server.registerTool(
    'baixar_anexo',
    {
      title: 'Baixar anexo',
      annotations: { title: 'Baixar anexo', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Gera links temporários para baixar anexos NA MÁQUINA de quem está usando (rode os comandos `comoBaixar` do resultado) ' +
        'ou, em chat web (sem terminal), para a sua ferramenta de leitura de URL abrir (`comoLer`: abra o `link`; vale 10 min e 3 acessos). O arquivo é buscado na fonte na hora do download e não fica guardado no serviço. ' +
        'Passe `ref` (e `nome`) de um anexo de `ver_curso`/`ver_forum`, ou `anexos` com vários da mesma conta ' +
        '(até 20). No Classroom, só arquivos anexados nas matérias são entregues. Arquivos do Drive linkados no Moodle ' +
        'também (a `ref` que começa com `gdrive1.`; só os que apareceram no curso): use SEMPRE a `ref`, nunca o link do Drive ' +
        'direto (ele pede login); o arquivo vem como ele é; sem acesso, o download responde 403 com a dica ' +
        'de conectar o Google Classroom. Vídeo e arquivo acima de 25 MB do Drive NÃO são baixados: o resultado traz `aviso` ' +
        '(tipo e tamanho) e `abrirNoNavegador` (link para a pessoa abrir), sem link de download.',
      inputSchema: {
        fonte: FONTE,
        conta: CONTA,
        ref: z.string().optional(),
        nome: z.string().optional(),
        anexos: z.array(z.object({ ref: z.string(), nome: z.string().optional() })).max(20).optional(),
      },
    },
    (args) => run(() => uc.baixarAnexo(p, args)),
  );

  // Escrita: só existe para o app que a pessoa autorizou com a permissão `moodle.forum_write` (ver docs/MCP.md).
  registerPermissionedTool(p, 'moodle.forum_write', () =>
    server.registerTool(
      'postar_forum',
      {
        title: 'Postar no fórum',
        annotations: { title: 'Postar no fórum', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
          'Publica no fórum do Moodle (AVA) em nome da pessoa. Dois modos: nova discussão (passe `forumId`, o de `ver_curso`) ou ' +
          'resposta (passe `postId`, o de `ver_forum`). Sempre `titulo` (no modo resposta, use "Re: " + o título da discussão) e `mensagem` (texto puro). ' +
          'A publicação não pode ser desfeita por aqui e fica visível para a turma e o professor: mostre o texto à pessoa e só publique depois que ela confirmar. ' +
          'Escreve na fonte (o AVA), na hora; não grava nada no serviço.',
        inputSchema: {
          conta: CONTA,
          forumId: z.string().optional(),
          postId: z.string().optional(),
          titulo: z.string(),
          mensagem: z.string(),
        },
      },
      (args) => run(() => uc.postarForum(p, args)),
    ),
  );

  // Escrita: entrega de tarefa do Moodle, só com a permissão `moodle.assignment_write` (ver docs/MCP.md).
  registerPermissionedTool(p, 'moodle.assignment_write', () => registerEntregaTools(server, uc, p));

  if (p.siasb && clinica) {
    registerClinicaTools(server, clinica, p);
    // Escrita: só com a permissão do app (ligada no painel) e o escritor disponível.
    const write = clinica.writes?.();
    if (write) {
      registerPermissionedTool(p, PERMISSAO_AGENDA, () => registerClinicaAgendaWriteTools(server, write, p));
      registerPermissionedTool(p, PERMISSAO_PROCEDIMENTOS, () => registerClinicaProcedimentoWriteTools(server, write, p));
    }
  }

  if (withMemory) {
    addMemoryTools(server, memory, p);
    // Chat web não tem terminal: o prompt de conectar computador não é exposto.
    if (!isWebChatClient(p.clientName)) {
      server.registerPrompt(
        CONNECT_PROMPT_NAME,
        {
          title: 'Conectar computador',
          description: 'Conecta este computador à memória compartilhada da ufba.app (pede a sua confirmação antes de instalar).',
        },
        () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: CONNECT_PROMPT_TEXT } }] }),
      );
    }
  }
  return server;
}

/**
 * Teto do base64 de UM arquivo em `arquivos` (~64 KB decodificado). O limite que vale de fato é o do parser JSON do Nest
 * (100 kb por corpo do /mcp, de propósito não aumentado: roda antes da autenticação e é global). Arquivo maior vai pelo `linkUpload`.
 */
const MAX_BASE64 = 90_000;

const TAREFA = {
  conta: CONTA,
  cursoId: z.string().describe('O `id` da matéria em `listar_cursos` (ou o `cursoId` de `prazos`).'),
  tarefaId: z
    .string()
    .describe('O `id` da atividade `tipo: tarefa` em `ver_curso` (o id do módulo no AVA, como está lá; não é outro id interno do Moodle).'),
};

const ENVIO = {
  ...TAREFA,
  texto: z.string().optional().describe('Texto online (texto puro), só se a tarefa aceita texto.'),
  uploadId: z.string().optional().describe('O `uploadId` de `preparar_envio_tarefa`, depois de mandar os arquivos pelo `linkUpload`.'),
  arquivos: z
    .array(z.object({ nome: z.string().min(1).max(255), conteudoBase64: z.string().max(MAX_BASE64) }))
    .max(20)
    .optional()
    .describe('Atalho só para arquivo MINÚSCULO: cerca de 64 KB somando todos (a requisição maior é recusada). Qualquer coisa maior vai pelo `linkUpload` de preparar_envio_tarefa. Não use junto com `uploadId`.'),
  confirmacaoId: z
    .string()
    .optional()
    .describe(
      'Omita na primeira chamada (só devolve o resumo). Passe o `confirmacaoId` do resumo SÓ depois do "sim" explícito da pessoa, ' +
        'SEM `texto`, `arquivos` ou `uploadId`: para mudar algo, peça um novo resumo sem `confirmacaoId`.',
    ),
};

const AVISOS_ENTREGA =
  'A entrega vai para o professor e NÃO pode ser desfeita por esta ferramenta. Em tarefa SEM o botão de enviar, salvar já entrega: ' +
  'use enviar_tarefa e nunca prometa rascunho. Salvar arquivos SUBSTITUI os arquivos atuais da entrega. ' +
  'Duas chamadas: a primeira (sem `confirmacaoId`) não grava nada e devolve um resumo com `confirmacaoId`; mostre o resumo à pessoa ' +
  'e só repita a chamada com o `confirmacaoId` depois de um "sim" explícito dela. Nunca confirme sem esse sim. ' +
  'A chamada com `confirmacaoId` não leva `texto`, `arquivos` nem `uploadId` (é recusada): se a pessoa quiser mudar algo, peça um novo resumo sem `confirmacaoId`. ' +
  'Arquivos: pelo `uploadId` (link de `preparar_envio_tarefa`) ou, só se minúsculos (~64 KB somados), em `arquivos` (base64). Escreve no AVA, na hora; não guarda o trabalho no serviço.';

/** Entrega de tarefa do Moodle (permissão `moodle.assignment_write`): preparar (leitura), salvar rascunho e enviar. */
function registerEntregaTools(server: McpServer, uc: McpUseCases, p: McpPrincipal): void {
  server.registerTool(
    'preparar_envio_tarefa',
    {
      title: 'Preparar envio de tarefa',
      annotations: { title: 'Preparar envio de tarefa', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Primeiro passo para entregar uma tarefa do Moodle (AVA): lê o que a tarefa aceita (arquivos e/ou texto, quantidade, tamanho, extensões), ' +
        'prazo e se já está atrasada, estado atual da entrega e se salvar JÁ ENTREGA (`salvarJaEntrega`) ou só grava rascunho. ' +
        'Se a tarefa aceita arquivo, devolve `linkUpload` de uso único (com `expiraEm`) e `comoEnviar`: mande TODOS os arquivos em UM só POST, ' +
        'ex.: curl -fS -F "file=@<caminho>" "<linkUpload>" (repita -F para mais arquivos), e depois use o `uploadId` em enviar_tarefa ou salvar_rascunho_tarefa. ' +
        'Se `podeEntregar` vier false (tarefa que aceita arquivo E texto, em grupo, com declaração, fechada ou não editável), não há link: ' +
        'diga o `motivo` à pessoa e oriente a entregar pelo AVA. Não grava nada na entrega.',
      inputSchema: TAREFA,
    },
    (args) => run(() => uc.prepararEnvioTarefa(p, args)),
  );

  server.registerTool(
    'salvar_rascunho_tarefa',
    {
      title: 'Salvar rascunho da tarefa',
      annotations: { title: 'Salvar rascunho da tarefa', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Salva a entrega de uma tarefa do Moodle como RASCUNHO, só em tarefa COM o botão de enviar (`salvarJaEntrega: false` em preparar_envio_tarefa); ' +
        'o professor ainda não recebe. Em tarefa sem o botão, é recusada: use enviar_tarefa. ' + AVISOS_ENTREGA,
      inputSchema: ENVIO,
    },
    (args) => run(() => uc.salvarRascunhoTarefa(p, args)),
  );

  server.registerTool(
    'enviar_tarefa',
    {
      title: 'Enviar tarefa',
      annotations: { title: 'Enviar tarefa', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Entrega uma tarefa do Moodle (AVA) ao professor em nome da pessoa. Sem conteúdo novo, manda para avaliação o rascunho que já está no AVA. ' +
        'O resultado final traz `enviado` (true quando ficou entregue) e `estado`; `estado: "desconhecido"` = gravou, mas não deu para ler o estado: ' +
        'diga para conferir no AVA. Erro ENTREGA_PARCIAL = ficou salvo como rascunho, mas não foi enviado: repita sem conteúdo para um novo resumo. ' +
        AVISOS_ENTREGA,
      inputSchema: ENVIO,
    },
    (args) => run(() => uc.enviarTarefa(p, args)),
  );
}

type Handler = (req: unknown, extra: unknown) => Promise<{ tools?: unknown[] } & Record<string, unknown>>;

/**
 * Soma as ferramentas `memory_*` às da casa. O McpServer só registra ferramentas com schema Zod; as do ai-memory
 * chegam com JSON Schema, então os dois handlers (`tools/list` e `tools/call`) são decorados: a lista é a soma e a
 * chamada vai ao proxy quando o nome é de memória (senão, ao handler original). O teste de contrato (mcp-memory.spec)
 * quebra se uma atualização do SDK mudar esse ponto.
 */
function addMemoryTools(server: McpServer, memory: McpMemory, p: McpPrincipal): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const houseList = handlers.get('tools/list');
  const houseCall = handlers.get('tools/call');
  if (!houseList || !houseCall) throw new Error('McpServer sem handlers de ferramentas');

  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const base = await houseList(req, extra);
    const remote = await memory.listTools(p.userId, { name: p.clientName });
    return { ...base, tools: [...(base.tools ?? []), ...remote] } as never;
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const result = await memory.call(p.userId, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, { name: p.clientName });
    return (result ?? (await houseCall(req, extra))) as never;
  });
}
