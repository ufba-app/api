import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { parseSiasbDateTime } from '../../domain/siasb/time';
import type { McpClinica, McpPrincipal } from './mcp-ports';
import { falha, json, run } from './tool-result';

/** Ferramentas das clínicas do SIASB (só aparecem para quem tem conexão SIASB). */
export const FERRAMENTAS_CLINICA = ['clinica_situacao', 'clinica_sessoes', 'clinica_prazo_marcacao'] as const;

const AO_VIVO =
  'Lê o SIASB AO VIVO, com a conexão que a pessoa fez; não grava nada. O prazo de marcação é um prazo estimado.';

const AVISO_FERIADOS = 'Feriados e recessos não considerados; confirme o prazo no SIASB.';
const NOTA_ESTIMADO = 'O prazo estimado é uma previsão, não o prazo oficial do SIASB.';

const ESTADOS = { NO_PATIENT: 'sem_paciente', NO_SESSION: 'sem_sessao', SCHEDULED: 'sessao_marcada' } as const;

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
    return e instanceof EntradaInvalida ? { isError: true, content: [{ type: 'text' as const, text: e.message }] } : falha(e);
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
}
