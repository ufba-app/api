import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { SiasbReadError, ReconectarError } from '../../application/siasb/siasb-session-runner';
import { WriteFailedError, WriteInputError, type WriteOutcome } from '../../application/siasb/siasb-writer';
import type { McpClinicaWrite, McpPrincipal } from './mcp-ports';
import { falha, json } from './tool-result';

/** Chaves de permissão (por app) que liberam cada par de ferramentas de escrita. */
export const PERMISSAO_AGENDA = 'siasb.schedule_write';
export const PERMISSAO_PROCEDIMENTOS = 'siasb.procedures_write';

export const FERRAMENTAS_ESCRITA_AGENDA = ['clinica_agendar_sessao', 'clinica_desmarcar_sessao'] as const;
export const FERRAMENTAS_ESCRITA_PROCEDIMENTOS = ['clinica_incluir_procedimento', 'clinica_excluir_procedimento'] as const;

const ESCREVE =
  'ESCREVE no SIASB com a conexão da pessoa, mas SÓ com `confirmado: true`. Chame primeiro SEM `confirmado` (ou com ' +
  '`false`): a resposta traz o resumo do que será feito; MOSTRE esse resumo à pessoa e peça o OK explícito dela antes de ' +
  'repetir a chamada com `confirmado: true`. Escrita no SIASB não se repete automaticamente: se der erro ou a resposta ' +
  'disser que o SIASB não confirmou, não tente de novo sozinho; peça à pessoa que confira no site do SIASB. ';

const CONFIRMADO = z
  .boolean()
  .default(false)
  .describe('`true` só depois de mostrar o resumo e a pessoa dar o OK explícito; sem isso nada é escrito.');

/**
 * ISO 8601 COM fuso (`Z` ou `±hh:mm`). Sem fuso ou inválido: erro de entrada, sem eco do valor. Segundos e frações são
 * descartados (minuto inteiro), para o mesmo instante ir ao SIASB e à conferência.
 */
function parseInicio(texto: string): Date {
  const t = texto.trim();
  const d = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(t) ? new Date(t) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw new WriteInputError('O início precisa ser data e hora ISO 8601 com fuso, como 2026-12-01T09:30:00-03:00.');
  }
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

const INSTRUCAO_ESCOLHER =
  'Peça à pessoa que escolha entre as opções o que está em `faltando`. Depois chame de novo SEM `confirmado` (ou com ' +
  '`false`), com os ids escolhidos, para receber o resumo; mostre o resumo e só então peça o OK da pessoa para chamar ' +
  'com `confirmado: true`. Nada foi escrito ainda.';

/** Resultado em português; nunca inclui texto livre do SIASB além do que o escritor já devolveu (mensagens fixas). */
function resposta(o: WriteOutcome) {
  if (o.status === 'choose') {
    return { status: 'escolher' as const, faltando: o.missing, opcoes: o.options, instrucao: INSTRUCAO_ESCOLHER };
  }
  return { status: o.status === 'preview' ? ('resumo' as const) : ('feito' as const), resumo: o.summary, detalhes: o.details };
}

const UNKNOWN_MESSAGE = 'O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo.';

/**
 * Executa a escrita e só repassa os erros conhecidos (mensagens fixas em pt-BR). Qualquer outro erro vira a resposta
 * fixa de "não confirmado", sem a mensagem original e sem log.
 */
async function runWrite(fn: () => Promise<WriteOutcome>) {
  try {
    return json(resposta(await fn()));
  } catch (e) {
    if (e instanceof WriteInputError || e instanceof WriteFailedError || e instanceof ReconectarError || e instanceof SiasbReadError) {
      return falha(e);
    }
    return falha(new WriteFailedError('siasb_write_unknown', UNKNOWN_MESSAGE));
  }
}

const opcional = (s?: string) => (s === undefined || s === '' ? undefined : s);

export function registerClinicaAgendaWriteTools(server: McpServer, write: McpClinicaWrite, p: McpPrincipal): void {
  server.registerTool(
    'clinica_agendar_sessao',
    {
      title: 'Agendar sessão de clínica',
      annotations: { title: 'Agendar sessão de clínica', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Agenda sessões de clínica de um atendimento ATIVO (`atendimentoId`, de `clinica_pacientes`) a partir de `inicio` ' +
        '(ISO 8601 com fuso), uma por semana, `quantidade` vezes, no mesmo horário; é tudo ou nada. Se faltar ' +
        '`professorId`, `localId` ou `grupoId`, a resposta (`status: escolher`) lista as opções para a pessoa escolher. ' +
        ESCREVE,
      inputSchema: {
        atendimentoId: z.string().describe('Id do atendimento ativo, de `clinica_pacientes`.'),
        inicio: z.string().describe('Início da primeira sessão, ISO 8601 com fuso (ex.: 2026-11-20T14:00:00-03:00).'),
        duracaoMin: z.number().int().min(15).max(240).describe('Duração de cada sessão, em minutos.'),
        quantidade: z.number().int().min(1).max(20).default(1).describe('Quantas sessões semanais a partir de `inicio` (padrão 1).'),
        professorId: z.string().optional().describe('Id do professor, das opções devolvidas.'),
        localId: z.string().optional().describe('Id do local, das opções devolvidas.'),
        grupoId: z.string().optional().describe('Id do grupo, das opções devolvidas.'),
        observacao: z.string().optional().describe('Observação para o SIASB (opcional).'),
        confirmado: CONFIRMADO,
      },
    },
    (a) =>
      runWrite(() =>
        write.scheduleSession(p.userId, {
          attendanceId: a.atendimentoId,
          start: parseInicio(a.inicio),
          durationMin: a.duracaoMin,
          count: a.quantidade ?? 1,
          professorId: opcional(a.professorId),
          localId: opcional(a.localId),
          grupoId: opcional(a.grupoId),
          observacao: a.observacao,
          confirmed: a.confirmado === true,
        }),
      ),
  );

  server.registerTool(
    'clinica_desmarcar_sessao',
    {
      title: 'Desmarcar sessão de clínica',
      annotations: { title: 'Desmarcar sessão de clínica', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Desmarca uma sessão de clínica marcada (`sessaoId`, de `clinica_sessoes`). Só funciona para sessões FUTURAS e ' +
        'nunca registra falta. Desmarcar é difícil de desfazer: a vaga pode ser perdida e remarcar depende do SIASB. ' +
        ESCREVE,
      inputSchema: {
        sessaoId: z.string().describe('Id da sessão, de `clinica_sessoes`.'),
        motivo: z.string().optional().describe('Motivo para o SIASB (opcional).'),
        confirmado: CONFIRMADO,
      },
    },
    (a) =>
      runWrite(() =>
        write.unscheduleSession(p.userId, { sessionId: a.sessaoId, motivo: a.motivo, confirmed: a.confirmado === true }),
      ),
  );
}

export function registerClinicaProcedimentoWriteTools(server: McpServer, write: McpClinicaWrite, p: McpPrincipal): void {
  server.registerTool(
    'clinica_incluir_procedimento',
    {
      title: 'Incluir procedimento previsto',
      annotations: { title: 'Incluir procedimento previsto', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Inclui um procedimento do catálogo (`procedimentoId`, o `id` de `clinica_contexto_agendamento`) no atendimento ' +
        '`atendimentoId`. O procedimento fica como PREVISTO; realizar (dar baixa) só se faz no site do SIASB. ' +
        ESCREVE,
      inputSchema: {
        atendimentoId: z.string().describe('Id do atendimento ativo, de `clinica_pacientes`.'),
        procedimentoId: z.string().describe('Id do procedimento no catálogo, de `clinica_contexto_agendamento`.'),
        dente: z.string().optional().describe('Dente (opcional).'),
        face: z.string().optional().describe('Face (opcional).'),
        observacao: z.string().optional().describe('Observação para o SIASB (opcional).'),
        confirmado: CONFIRMADO,
      },
    },
    (a) =>
      runWrite(() =>
        write.addProcedure(p.userId, {
          attendanceId: a.atendimentoId,
          serviceId: a.procedimentoId,
          teeth: a.dente,
          faces: a.face,
          observacao: a.observacao,
          confirmed: a.confirmado === true,
        }),
      ),
  );

  server.registerTool(
    'clinica_excluir_procedimento',
    {
      title: 'Excluir procedimento previsto',
      annotations: { title: 'Excluir procedimento previsto', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Exclui um procedimento PREVISTO que foi incluído por `clinica_incluir_procedimento` (`procedimentoId` é o ' +
        '`procedimentoId` devolvido ao incluir, não o do catálogo). Procedimento lançado por outro caminho (site do SIASB) ' +
        'é recusado: exclua pelo site. Excluir não dá para desfazer por aqui. ' +
        ESCREVE,
      inputSchema: {
        atendimentoId: z.string().describe('Id do atendimento ativo, de `clinica_pacientes`.'),
        procedimentoId: z.string().describe('Id devolvido por `clinica_incluir_procedimento` (não o do catálogo).'),
        confirmado: CONFIRMADO,
      },
    },
    (a) =>
      runWrite(() =>
        write.removeProcedure(p.userId, {
          attendanceId: a.atendimentoId,
          procedureId: a.procedimentoId,
          confirmed: a.confirmado === true,
        }),
      ),
  );
}
