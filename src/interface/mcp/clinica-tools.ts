import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { InvalidPeriodError } from '../../application/siasb/siasb-reader';
import { PROGRESS_DEFAULT_DAYS, PROGRESS_MAX_DAYS } from '../../application/siasb/progress';
import { parseSiasbDateTime } from '../../domain/siasb/time';
import type { McpClinica, McpPrincipal } from './mcp-ports';
import { falha, json, run } from './tool-result';

/** Ferramentas das clínicas do SIASB (só aparecem para quem tem conexão SIASB). */
export const FERRAMENTAS_CLINICA = [
  'clinica_situacao',
  'clinica_sessoes',
  'clinica_prazo_marcacao',
  'clinica_pacientes',
  'clinica_vagas',
  'clinica_contexto_agendamento',
  'clinica_progresso',
] as const;

const AO_VIVO =
  'Lê o SIASB AO VIVO, com a conexão que a pessoa fez; não grava nada. O prazo de marcação é um prazo estimado.';

const AVISO_FERIADOS = 'Feriados e recessos não considerados; confirme o prazo no SIASB.';
const NOTA_ESTIMADO = 'O prazo estimado é uma previsão, não o prazo oficial do SIASB.';

const ESTADOS = { NO_PATIENT: 'sem_paciente', NO_SESSION: 'sem_sessao', SCHEDULED: 'sessao_marcada' } as const;

const TIPOS = { TRIAGE: 'triagem', PLANNING: 'planejamento', URGENCY: 'urgencia', UNKNOWN: 'desconhecido' } as const;

const OBSERVACAO_CONTEXTO =
  'A estimativa de quantas sessões marcar vem do modelo, com conhecimento geral; quem confirma é o professor. ' +
  'O procedimento que o aluno citar serve só para essa estimativa e nunca é enviado ao SIASB. ' +
  'Conta só as sessões dos últimos 60 dias.';

/** "Período: 18/07 a 15/11/2026" a partir de dois ISO com offset da Bahia (o ano vai nos dois se forem diferentes). */
function periodoTexto(de: string, ate: string): string {
  const [dy, dm, dd] = de.slice(0, 10).split('-');
  const [ay, am, ad] = ate.slice(0, 10).split('-');
  return dy === ay ? `Período: ${dd}/${dm} a ${ad}/${am}/${ay}` : `Período: ${dd}/${dm}/${dy} a ${ad}/${am}/${ay}`;
}

/** Hora da Bahia (UTC-03:00 fixo, sem horário de verão) escrita com o offset, para o agente mostrar a hora local. */
export function toBahiaIso(d: Date): string {
  return `${new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
}

const iso = (d: Date | null) => (d ? toBahiaIso(d) : null);

/** Decide por requisição se a pessoa vê as `clinica_*`. Falhar ao resolver nunca derruba o MCP: vale `false`. */
export async function resolveSiasbFlag(clinica: McpClinica | undefined, userId: string): Promise<boolean> {
  if (!clinica) return false;
  try {
    return (await clinica.hasConnection(userId)) === true;
  } catch {
    return false;
  }
}

class EntradaInvalida extends Error {}

/** Data ISO; sem hora vale a hora da Bahia (`fim: true` = fim do dia). */
function parseData(texto: string, fim = false): Date {
  const t = texto.trim();
  const completa = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T${fim ? '23:59:59' : '00:00:00'}` : t;
  try {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(completa)) throw new Error();
    return parseSiasbDateTime(completa);
  } catch {
    throw new EntradaInvalida('Data inválida: use o formato ISO, como 2026-11-27 ou 2026-11-27T10:00:00-03:00.');
  }
}

async function runEntrada<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (e) {
    return e instanceof EntradaInvalida || e instanceof InvalidPeriodError ? { isError: true, content: [{ type: 'text' as const, text: e.message }] } : falha(e);
  }
}

export function registerClinicaTools(server: McpServer, clinica: McpClinica, p: McpPrincipal): void {
  server.registerTool(
    'clinica_situacao',
    {
      description:
        'Situação da pessoa em cada disciplina de clínica do SIASB: `estado` (`sem_paciente`, `sem_sessao` ou ' +
        '`sessao_marcada`), `proximaClinica` (próximo horário conhecido) e `prazoEstimado` (até quando marcar o ' +
        'paciente; é um prazo estimado). Horários com offset da Bahia (-03:00). ' + AO_VIVO,
      inputSchema: {},
    },
    () =>
      run(async () => {
        const rows = await clinica.situation(p.userId);
        const semFeriados = rows.some((r) => !r.holidaysConsidered);
        return {
          nota: NOTA_ESTIMADO,
          ...(semFeriados ? { aviso: AVISO_FERIADOS } : {}),
          disciplinas: rows.map((r) => ({
            disciplinaId: r.disciplineId,
            disciplina: r.disciplineName,
            estado: ESTADOS[r.state],
            proximaClinica: iso(r.nextSlot),
            prazoEstimado: iso(r.deadline),
            feriadosConsiderados: r.holidaysConsidered,
          })),
        };
      }),
  );

  server.registerTool(
    'clinica_sessoes',
    {
      description:
        'Sessões de clínica da pessoa no SIASB entre `de` e `ate` (datas ISO; padrão: próximos 14 dias; no máximo 45 ' +
        'dias à frente). Traz disciplina, horário (offset da Bahia), local, professor, iniciais do paciente, situação ' +
        'e `reagendamentoPara`. Nunca traz nome completo nem prontuário. ' + AO_VIVO,
      inputSchema: {
        de: z.string().optional().describe('Início, ISO (ex.: 2026-11-27).'),
        ate: z.string().optional().describe('Fim, ISO (ex.: 2026-12-04).'),
      },
    },
    (args) =>
      runEntrada(async () => {
        const from = args.de ? parseData(args.de) : undefined;
        const to = args.ate ? parseData(args.ate, true) : undefined;
        const range = from && to ? { from, to } : from ? { from, to: new Date(from.getTime() + 14 * 86_400_000) } : undefined;
        if (!from && to) throw new EntradaInvalida('Informe `de` junto com `ate`.');
        if (from && to && from.getTime() > to.getTime()) {
          throw new EntradaInvalida('O início do período (`de`) vem depois do fim (`ate`).');
        }
        const sessions = await clinica.sessions(p.userId, range);
        return {
          sessoes: sessions.map((s) => ({
            disciplina: s.disciplineName,
            inicio: toBahiaIso(s.startAt),
            fim: toBahiaIso(s.endAt),
            local: s.locationName,
            professor: s.professorName,
            iniciais: s.initials,
            situacao: s.statusLabel,
            reagendamentoPara: iso(s.rescheduledStartAt),
          })),
        };
      }),
  );

  server.registerTool(
    'clinica_prazo_marcacao',
    {
      description:
        'Prazo estimado para marcar paciente em uma sessão de clínica. Passe EXATAMENTE UM: `disciplinaId` (de ' +
        '`clinica_situacao`; usa o próximo horário conhecido) ou `inicioSessao` (início ISO de uma sessão). ' +
        'Horários com offset da Bahia (-03:00). ' + AO_VIVO,
      inputSchema: {
        disciplinaId: z.string().optional(),
        inicioSessao: z.string().optional().describe('Início da sessão, ISO (ex.: 2026-11-27T10:00:00-03:00).'),
      },
    },
    (args) =>
      runEntrada(async () => {
        if (Boolean(args.disciplinaId) === Boolean(args.inicioSessao)) {
          throw new EntradaInvalida('Informe exatamente um: `disciplinaId` ou `inicioSessao`.');
        }
        const input = args.disciplinaId
          ? { disciplineId: args.disciplinaId }
          : { sessionStart: parseData(args.inicioSessao as string) };
        const r = await clinica.bookingDeadline(p.userId, input);
        return {
          nota: NOTA_ESTIMADO,
          prazoEstimado: toBahiaIso(r.deadline),
          feriadosConsiderados: r.holidaysConsidered,
          ...(r.holidaysConsidered ? {} : { aviso: AVISO_FERIADOS }),
        };
      }),
  );

  server.registerTool(
    'clinica_pacientes',
    {
      description:
        'Atendimentos ATIVOS da pessoa por disciplina de clínica: `atendimentoId`, `iniciais` do paciente e `tipo` ' +
        '(`triagem`, `planejamento`, `urgencia` ou `desconhecido`). Nunca traz nome completo nem prontuário. ' + AO_VIVO,
      inputSchema: {},
    },
    () =>
      run(async () => ({
        disciplinas: (await clinica.patients(p.userId)).map((d) => ({
          disciplinaId: d.disciplineId,
          disciplina: d.disciplineName,
          pacientes: d.patients.map((x) => ({ atendimentoId: x.attendanceId, iniciais: x.initials, tipo: TIPOS[x.type] })),
        })),
      })),
  );

  server.registerTool(
    'clinica_vagas',
    {
      description:
        'Quantos pacientes sem responsável (vagas para pegar) há em cada disciplina de clínica. Só números: a lista ' +
        'de pacientes nunca é lida por esta ferramenta. ' + AO_VIVO,
      inputSchema: {},
    },
    () =>
      run(async () => ({
        disciplinas: (await clinica.vacancies(p.userId)).map((d) => ({
          disciplinaId: d.disciplineId,
          disciplina: d.disciplineName,
          vagas: d.count,
        })),
      })),
  );

  server.registerTool(
    'clinica_contexto_agendamento',
    {
      description:
        'Contexto para marcar as sessões de um atendimento ATIVO (`atendimentoId`, de `clinica_pacientes`): duração ' +
        'da sessão na clínica, quantas sessões o atendimento já teve (janela de uns 60 dias), procedimentos do ' +
        'catálogo (`busca` filtra sem acento nem maiúsculas; sem `busca`, os 50 primeiros) e os próximos horários ' +
        'com prazo estimado. A estimativa de quantas sessões marcar é do modelo, com conhecimento geral; quem ' +
        'confirma é o professor. O procedimento que o aluno citar serve só para essa estimativa e nunca é enviado ' +
        'ao SIASB. ' + AO_VIVO,
      inputSchema: {
        atendimentoId: z.string().describe('Id do atendimento ativo, de `clinica_pacientes`.'),
        busca: z.string().optional().describe('Texto para filtrar o catálogo de procedimentos pelo nome.'),
      },
    },
    (args) =>
      run(async () => {
        const c = await clinica.schedulingContext(p.userId, args.atendimentoId, args.busca);
        return {
          atendimentoId: c.attendanceId,
          disciplina: c.disciplineName,
          duracaoSessaoMin: c.sessionDurationMin,
          sessoesDoAtendimento: c.attendanceSessions,
          procedimentos: c.procedures.map((x) => ({ id: x.id, nome: x.name })),
          totalProcedimentos: c.totalProcedures,
          maisProcedimentos: c.moreProcedures,
          proximosHorarios: c.nextSlots.map((s) => ({ inicio: toBahiaIso(s.start), prazoEstimado: toBahiaIso(s.deadline) })),
          feriadosConsiderados: c.holidaysConsidered,
          ...(c.holidaysConsidered ? {} : { aviso: AVISO_FERIADOS }),
          nota: NOTA_ESTIMADO,
          observacao: OBSERVACAO_CONTEXTO,
        };
      }),
  );

  server.registerTool(
    'clinica_progresso',
    {
      description:
        'Progresso da pessoa nas clínicas num período: por disciplina, atendimentos ativos, concluídos no período ' +
        '(com alguma sessão nele) e no histórico todo, sessões atendidas e marcadas adiante; e o ritmo (sessões por ' +
        'semana, semanas sem sessão, horários habituais). Passe `desde` e `ate` (ISO, os dois ou nenhum; no máximo ' +
        `${PROGRESS_MAX_DAYS} dias) com as datas do semestre: pegue-as de uma ferramenta de calendário, se houver, ` +
        `ou pergunte ao aluno. Sem datas vale o padrão de ${PROGRESS_DEFAULT_DAYS} dias até agora, que é ` +
        'aproximado. A resposta diz o período usado. Só iniciais de paciente. ' + AO_VIVO,
      inputSchema: {
        desde: z.string().optional().describe('Início do período, ISO (ex.: 2026-08-10).'),
        ate: z.string().optional().describe('Fim do período, ISO (ex.: 2026-12-19).'),
      },
    },
    (args) =>
      runEntrada(async () => {
        if (Boolean(args.desde) !== Boolean(args.ate)) {
          throw new EntradaInvalida(
            `Informe \`desde\` e \`ate\` juntos, ou nenhum dos dois para usar os últimos ${PROGRESS_DEFAULT_DAYS} dias.`,
          );
        }
        let range: { from: Date; to: Date } | undefined;
        if (args.desde && args.ate) {
          range = { from: parseData(args.desde), to: parseData(args.ate, true) };
          if (range.from.getTime() > range.to.getTime()) {
            throw new EntradaInvalida('O início do período (`desde`) vem depois do fim (`ate`).');
          }
          if (range.to.getTime() - range.from.getTime() > PROGRESS_MAX_DAYS * 86_400_000) {
            throw new EntradaInvalida(`O período não pode passar de ${PROGRESS_MAX_DAYS} dias.`);
          }
        }
        const r = await clinica.progress(p.userId, range);
        const de = toBahiaIso(new Date(r.period.from));
        const ate = toBahiaIso(new Date(r.period.to));
        return {
          periodo: { de, ate, ePadrao: r.period.isDefault },
          periodoTexto: periodoTexto(de, ate),
          ...(r.period.isDefault
            ? {
                observacao:
                  `Período padrão de ${PROGRESS_DEFAULT_DAYS} dias, aproximado. Se puder, pegue as datas do semestre ` +
                  '(de uma ferramenta de calendário ou perguntando ao aluno) e chame de novo com `desde` e `ate`.',
              }
            : {}),
          disciplinas: r.disciplines.map((d) => ({
            disciplinaId: d.disciplineId,
            disciplina: d.disciplineName,
            atendimentosAtivos: d.activeAttendances,
            concluidosNoPeriodo: d.concludedInPeriod,
            concluidosNoHistorico: d.concludedAllTime,
            sessoesAtendidas: d.sessionsAttended,
            sessoesMarcadasAdiante: d.sessionsScheduledAhead,
          })),
          ritmo: {
            nota:
              'Calculado só sobre a parte do período que já passou, com semanas contadas de 7 em 7 dias a partir do início do período; sessoesPorSemana é null com menos de 1 dia decorrido.',
            sessoesPorSemana: r.rhythm.sessionsPerWeek,
            semanasSemSessao: r.rhythm.weeksWithoutSession,
            horariosHabituais: r.rhythm.usualSlots.map((s) => ({ diaSemana: s.weekday, horario: s.time })),
          },
          avisos: r.warnings,
        };
      }),
  );
}
