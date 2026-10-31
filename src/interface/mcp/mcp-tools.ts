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
  const server = new McpServer({ name: 'platform', version: '0.0.1' });

  server.registerTool(
    'sincronizar',
    {
      description:
        'ÚNICA ferramenta que vai buscar dados nas fontes (SIGAA, Moodle, Classroom, Calendar) e gravar no banco. ' +
        'Use quando `atualizadoEm` de uma leitura estiver velho. alcance: "tudo", "curso" (cursoId = id do curso na fonte) ' +
        'ou "item" (cursoId + itemId). O SIGAA só aceita "tudo" e exige `credencial` {usuario, senha}, usada só nesta chamada ' +
        '(em memória, nunca guardada). Moodle e Google usam o token guardado na conexão; não peça nem aceite tokens aqui, ' +
        'eles são conectados pela tela de autorização.',
      inputSchema: {
        fonte: FONTE,
        alcance: z.enum(['tudo', 'curso', 'item']).default('tudo'),
        cursoId: z.string().optional(),
        itemId: z.string().optional(),
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
        'Lista avisos, tarefas, provas, materiais e fóruns das disciplinas (cada item traz seus `attachments`, ' +
        'com os ids para `ler_anexo`). ' + LEITURA,
      inputSchema: {
        fonte: FONTE.optional(),
        cursoId: z.string().optional(),
        tipo: z.enum(['aviso', 'tarefa', 'prova', 'material', 'forum', 'outro']).optional(),
        limite: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => run(() => uc.listarItens(p, args)),
  );

  server.registerTool(
    'agenda',
    {
      description:
        'Agenda do aluno (prazos e eventos) num intervalo; padrão: de agora até 14 dias. `de`/`ate` em ISO 8601. ' +
        LEITURA,
      inputSchema: { de: z.string().optional(), ate: z.string().optional() },
    },
    (args) => run(() => uc.agenda(p, args)),
  );

  server.registerTool(
    'mudancas',
    {
      description:
        'O que mudou (novo, alterado, removido) desde um instante, detectado nas sincronizações; padrão: últimos 7 dias. ' +
        '`desde` em ISO 8601. ' +
        LEITURA,
      inputSchema: { desde: z.string().optional() },
    },
    (args) => run(() => uc.mudancas(p, args)),
  );

  server.registerTool(
    'perfil',
    {
      description: 'Perfil acadêmico do aluno (matrícula, curso, contas conectadas). ' + LEITURA,
      inputSchema: {},
    },
    () => run(() => uc.perfil(p)),
  );

  server.registerTool(
    'historico',
    {
      description:
        'Histórico acadêmico já importado (disciplinas cursadas e pendentes). Se for null, ainda não foi importado: ' +
        'use `importar_historico`. ' + LEITURA,
      inputSchema: {},
    },
    () => run(() => uc.historico(p)),
  );

  server.registerTool(
    'insights',
    {
      description:
        'Análises calculadas sobre o histórico já importado: tipo "cr" (coeficiente de rendimento), ' +
        '"trajetoria" (desempenho por semestre) ou "pendentes" (o que falta cursar). ' +
        LEITURA,
      inputSchema: { tipo: z.enum(['cr', 'trajetoria', 'pendentes']) },
    },
    ({ tipo }) => run(() => uc.insights(p, tipo)),
  );

  server.registerTool(
    'importar_historico',
    {
      description:
        'Importa o histórico acadêmico: entra no SIGAA com usuario/senha (usados só nesta chamada, em memória, nunca ' +
        'guardados), baixa o PDF do histórico, extrai e valida. Divergências de validação vêm no resultado. ' +
        'Chame só quando `historico` estiver vazio ou velho; é lento.',
      inputSchema: { usuario: z.string(), senha: z.string() },
    },
    (args) => run(() => uc.importarHistorico(p, args)),
  );

  server.registerTool(
    'ler_anexo',
    {
      description:
        'Lê o conteúdo de um anexo de um item (busca na fonte sob demanda; o banco guarda só metadados). ' +
        'Use `itemId` e o `id` do anexo vindos de `listar_itens`. Texto volta como texto; binário, em base64.',
      inputSchema: { itemId: z.string(), anexoId: z.string() },
    },
    (args) => run(() => uc.lerAnexo(p, args)),
  );

  return server;
}
