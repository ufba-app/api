import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { McpPrincipal, McpUseCases } from './mcp-ports';

const FONTE = z.enum(['sigaa', 'moodle', 'classroom', 'calendar']);

const LEITURA =
  'Somente leitura: consulta o banco e NÃO atualiza nada nas fontes. ' +
  'Confira `atualizadoEm` no resultado; se o dado estiver velho para o que o usuário precisa, ' +
  'chame antes a ferramenta `sincronizar`.';

/** Ferramentas que só leem do banco (o teste garante que nunca tocam em fonte). */
export const FERRAMENTAS_LEITURA = [
  'listar_itens',
  'agenda',
  'mudancas',
  'perfil',
  'historico',
  'insights',
] as const;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function falha(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: msg }] };
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
  const server = new McpServer({ name: 'platform', version: '0.0.1' });

  server.registerTool(
    'sincronizar',
    {
      description:
        'ÚNICA ferramenta que vai buscar dados nas fontes (SIGAA, Moodle, Classroom, Calendar) e gravar no banco. ' +
        'Use quando `atualizadoEm` de uma leitura estiver velho. alcance: "tudo", "curso" (alvoId = id do curso) ou "item" (alvoId = id do item). ' +
        'A credencial é opcional e só vale para esta chamada (ex.: senha do SIGAA, usada em memória e descartada). ' +
        'Não peça nem aceite tokens do Moodle/Google aqui: eles são conectados pela tela de autorização.',
      inputSchema: {
        fonte: FONTE,
        alcance: z.enum(['tudo', 'curso', 'item']).default('tudo'),
        alvoId: z.string().optional(),
        credencial: z
          .object({ usuario: z.string().optional(), senha: z.string().optional() })
          .optional(),
      },
    },
    (args) => run(() => uc.sincronizar(p, args)),
  );

  server.registerTool(
    'listar_itens',
    {
      description:
        'Lista avisos, tarefas, provas, materiais e fóruns das disciplinas. ' + LEITURA,
      inputSchema: {
        fonte: FONTE.optional(),
        cursoId: z.string().optional(),
        tipo: z.enum(['aviso', 'tarefa', 'prova', 'material', 'forum']).optional(),
        limite: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) => run(() => uc.listarItens(p, args)),
  );

  server.registerTool(
    'agenda',
    {
      description:
        'Agenda do aluno (eventos, prazos e aulas) num intervalo. `de`/`ate` em ISO 8601. ' + LEITURA,
      inputSchema: { de: z.string().optional(), ate: z.string().optional() },
    },
    (args) => run(() => uc.agenda(p, args)),
  );

  server.registerTool(
    'mudancas',
    {
      description:
        'O que mudou (novo, alterado, removido) desde um instante, detectado nas sincronizações. ' +
        '`desde` em ISO 8601. ' +
        LEITURA,
      inputSchema: { desde: z.string().optional(), fonte: FONTE.optional() },
    },
    (args) => run(() => uc.mudancas(p, args)),
  );

  server.registerTool(
    'perfil',
    {
      description: 'Perfil acadêmico do aluno (curso, matrícula, vínculos). ' + LEITURA,
      inputSchema: {},
    },
    () => run(() => uc.perfil(p)),
  );

  server.registerTool(
    'historico',
    {
      description: 'Histórico acadêmico importado (disciplinas cursadas e pendentes). ' + LEITURA,
      inputSchema: { incluirPendentes: z.boolean().optional() },
    },
    (args) => run(() => uc.historico(p, args)),
  );

  server.registerTool(
    'insights',
    {
      description:
        'Análises calculadas sobre o histórico: tipo "cr" (coeficiente de rendimento), ' +
        '"trajetoria" (progresso no currículo) ou "pendentes" (o que falta cursar). ' +
        LEITURA,
      inputSchema: { tipo: z.enum(['cr', 'trajetoria', 'pendentes']) },
    },
    ({ tipo }) => run(() => uc.insights(p, tipo)),
  );

  server.registerTool(
    'ler_anexo',
    {
      description:
        'Lê o conteúdo de um anexo de um item (busca na fonte sob demanda, com cache curto; o banco guarda só metadados). ' +
        'Use os ids obtidos em `listar_itens`.',
      inputSchema: { itemId: z.string(), anexoId: z.string() },
    },
    (args) => run(() => uc.lerAnexo(p, args)),
  );

  return server;
}
