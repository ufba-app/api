import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { CONNECT_PROMPT_NAME, CONNECT_PROMPT_TEXT } from '../../application/memory/connect-guide';
import { memoryInstructionsFor } from '../../application/memory/memory-proxy';
import { isWebChatClient } from '../../application/memory/connect-guide';
import { registerClinicaTools } from './clinica-tools';
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

const AO_VIVO = 'Consulta a fonte AO VIVO, em UMA conta, com o acesso que a pessoa conectou; não grava nada.';

/** Ferramentas e quantas chamadas cada uma faz à fonte (o teste garante esse teto). */
export const FERRAMENTAS = [
  'listar_contas',
  'listar_cursos',
  'prazos',
  'ver_curso',
  'ver_forum',
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
  const server = new McpServer(
    { name: 'platform', version: '0.1.0' },
    withMemory ? { instructions: memoryInstructionsFor(p.clientName) } : undefined,
  );

  server.registerTool(
    'listar_contas',
    {
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
      description:
        'Lista as matérias da pessoa na fonte (padrão: só as em andamento; `todas: true` inclui passadas e futuras). ' +
        'Use o `id` em `ver_curso`, com a mesma `fonte` e `conta`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, todas: z.boolean().optional() },
    },
    (args) => run(() => uc.listarCursos(p, args)),
  );

  server.registerTool(
    'prazos',
    {
      description:
        'Próximos prazos das matérias atuais (tarefas a entregar, provas, eventos). Moodle: uma consulta ao ' +
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
      description:
        'Conteúdo de UMA matéria: tarefas (com descrição e prazo), materiais, avisos, provas e fóruns. Moodle: anexos ' +
        'com `ref` para `baixar_anexo` e `forumId` para `ver_forum`. Classroom: arquivos em `abrirNoNavegador` ' +
        '(links do Drive que a pessoa abre no próprio navegador). Use o `id` de `listar_cursos` ou o `cursoId` de ' +
        '`prazos`, com a mesma `fonte` e `conta`. ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, cursoId: z.string() },
    },
    (args) => run(() => uc.verCurso(p, args)),
  );

  server.registerTool(
    'ver_forum',
    {
      description:
        'Discussões de UM fórum do Moodle (inclui o fórum de avisos da matéria), com mensagem e anexos. Use o ' +
        '`forumId` vindo de `ver_curso`. (O Classroom não tem fóruns: os avisos vêm em `ver_curso`.) ' + AO_VIVO,
      inputSchema: { fonte: FONTE, conta: CONTA, forumId: z.string() },
    },
    (args) => run(() => uc.verForum(p, args)),
  );

  server.registerTool(
    'ver_aviso',
    {
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
      description:
        'Gera links temporários (uso único) para baixar anexos NA MÁQUINA de quem está usando: rode os comandos ' +
        '`comoBaixar` do resultado. O arquivo é buscado na fonte na hora do download e não fica guardado no serviço. ' +
        'Passe `ref` (e `nome`) de um anexo de `ver_curso`/`ver_forum`, ou `anexos` com vários da mesma conta ' +
        '(até 20). No Classroom, só arquivos anexados nas matérias são entregues.',
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

  if (p.siasb && clinica) registerClinicaTools(server, clinica, p);

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
