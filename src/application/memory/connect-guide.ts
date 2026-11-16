import type { RemoteTool } from './memory-ports';

/** Tela de computadores do painel (a origem do painel vem de `WEB_ORIGIN`; os comandos abaixo ficam na landing). */
export const computersUrl = (webOrigin: string): string => `${webOrigin.replace(/\/+$/, '')}/memory/computers`;
export const INSTALLER_REPO_URL = 'https://github.com/ufba-app/memory';

export const CONNECT_COMMANDS = {
  windows: 'irm https://memory.ufba.app/install.ps1 | iex',
  macos: 'curl -fsSL https://memory.ufba.app/install.sh | sh',
  linux: 'curl -fsSL https://memory.ufba.app/install.sh | sh',
} as const;

export type GuideOs = keyof typeof CONNECT_COMMANDS;

/**
 * Clientes de CHAT web/desktop: sem terminal nem acesso ao computador da pessoa, então a conexão de computador não faz
 * sentido (o agente ofereceria um comando que ele nem pode rodar). Vem do `clientInfo.name` do `initialize` do MCP, em
 * minúsculas. Os nomes NÃO são documentados oficialmente (o MCP só diz que `name` existe), então a lista é a dos valores
 * observados na prática; cliente que não está aqui cai no texto condicional (a rede de segurança da camada 2).
 */
const WEB_CHAT_CLIENTS = new Set(['claude-ai', 'claude.ai', 'claude-desktop', 'claude desktop', 'chatgpt', 'openai-mcp', 'openai', 'perplexity']);

export function isWebChatClient(name: string | null | undefined): boolean {
  const n = name?.trim().toLowerCase();
  if (!n) return false;
  return WEB_CHAT_CLIENTS.has(n) || n.startsWith('chatgpt') || n.startsWith('openai');
}

/** Hint do `memory_status` sem computador: em chat web não oferece nada; nos demais, só sob condição. */
export const HINT_NO_COMPUTER_WEB = 'Nenhum computador conectado.';
export const HINT_NO_COMPUTER_CONDITIONAL =
  'Nenhum computador conectado. Só se você roda num terminal ou editor com acesso ao computador da pessoa E ela quiser a captura ' +
  'automática, ofereça `memory_connect_computer`; num chat web, não mencione isso.';

export const MEMORY_CONNECT_TOOL: RemoteTool = {
  name: 'memory_connect_computer',
  description:
    'Devolve, como TEXTO, o passo a passo para conectar o computador desta pessoa à memória compartilhada (captura ' +
    'automática das sessões): o comando de uma linha do sistema, o que ele faz e como desfazer. Não executa nada e ' +
    'não devolve segredo. Use quando `memory_status` disser que não há computador conectado e a pessoa quiser a ' +
    'captura automática; peça permissão à pessoa ANTES de rodar o comando.',
  inputSchema: {
    type: 'object',
    properties: {
      os: {
        type: 'string',
        enum: ['windows', 'macos', 'linux'],
        description: 'Sistema do computador. Se omitir, mostra o comando de cada sistema.',
      },
    },
    additionalProperties: false,
  },
};

const NAMES: Record<GuideOs, string> = { windows: 'Windows (PowerShell)', macos: 'macOS (Terminal)', linux: 'Linux (shell)' };

function commandBlock(os: GuideOs | undefined): string {
  if (os) return `Comando para ${NAMES[os]}:\n\n    ${CONNECT_COMMANDS[os]}`;
  return [
    'Comando por sistema:',
    '',
    `    Windows (PowerShell):  ${CONNECT_COMMANDS.windows}`,
    `    macOS / Linux:         ${CONNECT_COMMANDS.macos}`,
  ].join('\n');
}

/** Texto do passo a passo. Sem segredo e sem efeito: só instrução para o agente repassar à pessoa. */
export function connectComputerGuide(os: unknown, webOrigin: string): string {
  const chosen = typeof os === 'string' && os in CONNECT_COMMANDS ? (os as GuideOs) : undefined;
  return [
    'Conectar este computador à memória compartilhada da ufba.app',
    '',
    'Antes de tudo: peça permissão à pessoa e explique, em poucas linhas, o que vai acontecer. Não rode nada sem o OK dela.',
    '',
    commandBlock(chosen),
    '',
    'O que o comando faz (nada com sudo ou administrador):',
    '  1. Instala o ai-memory v3.4.6 (ou, se a pessoa já usa o ai-memory, só registra um perfil chamado `ufba`, sem tocar no servidor dela).',
    '  2. Abre o navegador para a pessoa aprovar este computador com a conta @ufba.br; o código que aparece no terminal precisa ser o mesmo da tela.',
    '  3. Grava a chave deste computador na pasta do ai-memory (a chave não passa pelo agente nem aparece na tela).',
    '  4. Instala os hooks de captura nos agentes que a pessoa escolher e registra o MCP `ufba` neles.',
    '  Nada é capturado de um repositório sem o arquivo `.ai-memory.toml`.',
    '',
    'Se este cliente não tem terminal, mostre o comando à pessoa para ela colar no terminal dela.',
    `Prefere ler o script antes de rodar? O código do instalador está em ${INSTALLER_REPO_URL} (o hash de cada versão fica no manifesto do release).`,
    `Para ver ou desconectar computadores: ${computersUrl(webOrigin)}`,
  ].join('\n');
}

/** Prompt MCP `conectar-computador` (vira `/mcp__ufba__conectar-computador` no Claude Code). */
export const CONNECT_PROMPT_NAME = 'conectar-computador';
export const CONNECT_PROMPT_TEXT =
  'Quero conectar este computador à memória compartilhada da ufba.app. Faça assim: (1) chame `memory_status` e veja se ' +
  'já há computador conectado; se houver, diga qual e pare. (2) Se não houver, chame `memory_connect_computer` (com o ' +
  'sistema deste computador, se você souber). (3) Explique em 3 linhas o que o comando faz. (4) Peça a minha ' +
  'confirmação e só então rode o comando; se você não tem terminal, mostre o comando para eu colar. Nunca rode comandos ' +
  'de instalação sem o meu OK.';
