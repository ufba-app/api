import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { McpPrincipal, McpUseCases } from './mcp-ports';

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

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Erro de ferramenta: só a mensagem (os casos de uso já não carregam senha nem token). */
function falha(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown })?.code;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: typeof code === 'string' ? `${code}: ${msg}` : msg }],
  };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (e) {
    return falha(e);
  }
}

/** Cria um servidor MCP para uma requisição, com ferramentas finas sobre os casos de uso. */
export function buildMcpServer(uc: McpUseCases, p: McpPrincipal): McpServer {
  const server = new McpServer({ name: 'platform', version: '0.1.0' });

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

  return server;
}
