import { isMarked } from '../../domain/siasb/clinical-state';
import { bahiaDateKey, bahiaWeekday } from '../../domain/siasb/alert-format';
import type { ClinicalAttendance, ClinicalSession } from '../../domain/siasb/types';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import { SiasbError, type SchedulingOptions, type SiasbSession, type SiasbSource } from '../ports/siasb-source';
import type { SiasbWriteAuditRepository, SiasbWriteKind, SiasbWriteResult } from '../ports/siasb-write-audit';
import type { SiasbSyncer } from './siasb-syncer';
import { SiasbReadError, SiasbSessionRunner } from './siasb-session-runner';
import { DAY_MS, MAX_AHEAD_DAYS } from './session-period';

/** Entrada inválida (nada foi escrito). A mensagem é fixa, em pt-BR, e nunca ecoa o valor recebido. */
export class WriteInputError extends Error {
  readonly code = 'entrada_invalida' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WriteInputError';
  }
}

export type WriteFailedCode = 'siasb_write_rejected' | 'siasb_write_unknown';

/** A escrita foi tentada e o SIASB recusou ou não confirmou. Mensagem fixa (ou uma das duas mensagens da grade). */
export class WriteFailedError extends Error {
  constructor(
    readonly code: WriteFailedCode,
    message: string,
  ) {
    super(message);
    this.name = 'WriteFailedError';
  }
}

export type WriteOutcome =
  | { status: 'preview'; summary: string; details: Record<string, unknown> }
  | { status: 'choose'; options: SchedulingOptions; missing: ('professor' | 'local' | 'grupo')[] }
  | { status: 'done'; summary: string; details: Record<string, unknown> };

const UNKNOWN_MESSAGE = 'O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo.';
const DEFAULT_REASON = 'Desmarcado pelo aluno';
const MAX_FREE_TEXT = 300;
const MAX_TOOTH_FACE = 50;
const MIN_COUNT = 1;
const MAX_COUNT = 20;
const MIN_DURATION = 15;
const MAX_DURATION = 240;
const MAX_START_DAYS = 365;
const UNSCHEDULE_BACK_DAYS = 14;
const WEEK_MS = 7 * DAY_MS;

const ATTENDANCE_NOT_FOUND =
  'Não achamos esse atendimento entre os seus atendimentos ativos. Confira o id em clinica_pacientes.';

/** Erro do SIASB → erro da escrita. Pura: só olha o código (e, na recusa, a mensagem já fixa do cliente). */
function mapWriteError(e: SiasbError): Error {
  if (e.code === 'WRITE_REJECTED') return new WriteFailedError('siasb_write_rejected', e.message);
  if (e.code === 'WRITE_UNKNOWN') return new WriteFailedError('siasb_write_unknown', UNKNOWN_MESSAGE);
  return new SiasbReadError(e.code === 'UNEXPECTED_FORMAT' ? 'siasb_unexpected_format' : 'siasb_unavailable');
}

const isDigits = (v: unknown): v is string => typeof v === 'string' && /^\d{1,12}$/.test(v);
const two = (n: number) => String(n).padStart(2, '0');

/** `sexta, 20/11/2026, às 10h` (ou `às 10h30`), na hora da Bahia. */
function bahiaWhen(d: Date): string {
  const [y, m, day] = bahiaDateKey(d).split('-');
  const local = new Date(d.getTime() - 3 * 3_600_000);
  const minutes = local.getUTCMinutes();
  return `${bahiaWeekday(d)}, ${day}/${m}/${y}, às ${local.getUTCHours()}h${minutes ? two(minutes) : ''}`;
}

function checkFreeText(v: unknown, label: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > MAX_FREE_TEXT) {
    throw new WriteInputError(`${label} precisa ser um texto de até ${MAX_FREE_TEXT} caracteres.`);
  }
  return v;
}

function checkShort(v: unknown, label: string): string {
  if (v === undefined || v === null) return '';
  // Sem quebra de linha nem caractere de controle: vai ao SIASB como campo curto.
  if (typeof v !== 'string' || v.length > MAX_TOOTH_FACE || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new WriteInputError(`${label} precisa ser um texto curto (até ${MAX_TOOTH_FACE} caracteres, sem quebra de linha).`);
  }
  return v.trim();
}

function requireId(v: unknown, label: string): string {
  if (!isDigits(v)) throw new WriteInputError(`O ${label} precisa ser um número (só dígitos).`);
  return v;
}

type WriteAttempt = { result: SiasbWriteResult; target?: string };
/** Resultado da única tentativa de escrita (null = nada foi escrito: preview, choose ou entrada inválida). */
type AttemptHolder = { attempt: WriteAttempt | null };

/**
 * Escrita no SIASB em nome da pessoa (agenda e procedimentos PREVISTOS). Duas etapas sem estado: sem `confirmed === true`
 * só valida e devolve o resumo; com `true`, escreve UMA vez (sem retry), relê para conferir, audita (só metadados) e
 * pede a ressincronização da cópia. Nunca realiza procedimento nem registra falta. Nada de texto livre, nome ou mensagem
 * do SIASB vai a log ou auditoria; esta classe não loga nada.
 */
export class SiasbWriter {
  constructor(
    private readonly runner: SiasbSessionRunner,
    private readonly siasb: SiasbSource,
    private readonly syncer: Pick<SiasbSyncer, 'syncUser'>,
    private readonly copy: Pick<SiasbCopyRepository, 'markDue'>,
    private readonly audit: SiasbWriteAuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async scheduleSession(
    userId: string,
    i: {
      attendanceId: string;
      start: Date;
      durationMin: number;
      professorId?: string;
      localId?: string;
      grupoId?: string;
      count: number;
      observacao?: string;
      confirmed: boolean;
    },
  ): Promise<WriteOutcome> {
    const now = this.now();
    const attendanceId = requireId(i.attendanceId, 'id do atendimento');
    if (!Number.isInteger(i.count) || i.count < MIN_COUNT || i.count > MAX_COUNT) {
      throw new WriteInputError(`A quantidade de sessões precisa ser um número inteiro de ${MIN_COUNT} a ${MAX_COUNT}.`);
    }
    if (!Number.isInteger(i.durationMin) || i.durationMin < MIN_DURATION || i.durationMin > MAX_DURATION) {
      throw new WriteInputError(`A duração precisa ser um número inteiro de ${MIN_DURATION} a ${MAX_DURATION} minutos.`);
    }
    if (!(i.start instanceof Date) || Number.isNaN(i.start.getTime())) {
      throw new WriteInputError('O início da sessão precisa ser uma data e hora válidas.');
    }
    if (i.start.getTime() <= now.getTime() || i.start.getTime() > now.getTime() + MAX_START_DAYS * DAY_MS) {
      throw new WriteInputError(`O início precisa ser no futuro e no máximo ${MAX_START_DAYS} dias à frente.`);
    }
    const description = checkFreeText(i.observacao, 'A observação');
    for (const [v, label] of [
      [i.professorId, 'id do professor'],
      [i.localId, 'id do local'],
      [i.grupoId, 'id do grupo'],
    ] as const) {
      if (v !== undefined && v !== null && v !== '') requireId(v, label);
    }
    const count = i.count;
    const durationMs = i.durationMin * 60_000;
    const starts = Array.from({ length: count }, (_, k) => new Date(i.start.getTime() + k * WEEK_MS));
    const confirmed = i.confirmed === true;
    const holder: AttemptHolder = { attempt: null };

    const run = this.runner.run(
      userId,
      async (session): Promise<WriteOutcome> => {
        await this.requireActive(session, attendanceId);
        const options = await this.siasb.schedulingOptions(session, attendanceId);
        const missing: ('professor' | 'local' | 'grupo')[] = [];
        if (!i.professorId) missing.push('professor');
        if (!i.localId) missing.push('local');
        if (!i.grupoId) missing.push('grupo');
        if (missing.length) return { status: 'choose', options, missing };
        const professor = options.professors.find((o) => o.id === i.professorId);
        const location = options.locations.find((o) => o.id === i.localId);
        const group = options.groups.find((o) => o.id === i.grupoId);
        if (!professor) throw new WriteInputError('Esse professor não está entre as opções do SIASB para este atendimento.');
        if (!location) throw new WriteInputError('Esse local não está entre as opções do SIASB para este atendimento.');
        if (!group) throw new WriteInputError('Esse grupo não está entre as opções do SIASB para este atendimento.');

        const when = `${bahiaWhen(i.start)} (horário da Bahia)`;
        const what =
          count === 1
            ? `1 sessão: ${when}, com ${i.durationMin} minutos.`
            : `${count} sessões semanais, uma por semana, no mesmo horário; é tudo ou nada. A primeira é ${when}, ` +
              `com ${i.durationMin} minutos cada.`;
        const tail =
          ` Professor: ${professor.name}. Local: ${location.name}. Grupo: ${group.name}.` +
          (description ? ' Vai com a observação informada.' : '');
        const details = {
          atendimentoId: attendanceId,
          quantidade: count,
          duracaoMin: i.durationMin,
          datas: starts.map((d) => d.toISOString()),
          professor: professor.name,
          local: location.name,
          grupo: group.name,
        };
        if (!confirmed) return { status: 'preview', summary: `Vai agendar ${what}${tail}`, details };

        await this.attemptWrite(holder, () =>
          this.siasb.scheduleSessions(session, {
            attendanceId,
            professorId: professor.id,
            locationId: location.id,
            groupId: group.id,
            startAt: i.start,
            endAt: new Date(i.start.getTime() + durationMs),
            count,
            description,
          }),
        );
        const last = starts[starts.length - 1];
        const after = await this.reread(session, i.start, new Date(last.getTime() + durationMs));
        const expected = new Set(starts.map((d) => d.getTime()));
        const confirmedDates = after
          ? [
              ...new Set(
                after
                  .filter((s) => s.attendanceId === attendanceId && expected.has(s.startAt.getTime()))
                  .map((s) => s.startAt.getTime()),
              ),
            ]
              .sort((a, b) => a - b)
              .map((t) => new Date(t).toISOString())
          : [];
        const verified = confirmedDates.length === count;
        return {
          status: 'done',
          summary:
            `O SIASB aceitou o agendamento de ${count === 1 ? '1 sessão' : `${count} sessões`}.` +
            (verified
              ? ' Conferimos na agenda: todas as datas estão lá.'
              : ' Mas não deu para confirmar todas as datas na agenda agora; confira em clinica_sessoes ou no site do SIASB.'),
          details: { ...details, verificado: verified, datasConfirmadas: confirmedDates },
        };
      },
      { mapError: mapWriteError },
    );
    return this.finish(userId, 'schedule', attendanceId, run, holder);
  }

  async unscheduleSession(
    userId: string,
    i: { sessionId: string; motivo?: string; confirmed: boolean },
  ): Promise<WriteOutcome> {
    const now = this.now();
    const sessionId = requireId(i.sessionId, 'id da sessão');
    const informed = checkFreeText(i.motivo, 'O motivo');
    const reason = informed.trim() ? informed : DEFAULT_REASON;
    const confirmed = i.confirmed === true;
    const from = new Date(now.getTime() - UNSCHEDULE_BACK_DAYS * DAY_MS);
    const to = new Date(now.getTime() + MAX_AHEAD_DAYS * DAY_MS);
    const holder: AttemptHolder = { attempt: null };
    let attendanceId: string | undefined;

    const run = this.runner.run(
      userId,
      async (session): Promise<WriteOutcome> => {
        const target = (await this.siasb.sessions(session, from, to)).find((s) => s.id === sessionId);
        if (!target) {
          throw new WriteInputError(
            'Não achamos essa sessão entre as suas sessões (de 14 dias atrás até 45 dias à frente). Confira o id em clinica_sessoes.',
          );
        }
        const active = await this.siasb.attendances(session, 'active');
        if (!active.some((a) => a.id === target.attendanceId)) {
          throw new WriteInputError('Essa sessão não é de um dos seus atendimentos ativos.');
        }
        if (!isMarked(target.statusLabel)) throw new WriteInputError('Essa sessão não está marcada; não há o que desmarcar.');
        attendanceId = target.attendanceId;
        const details = {
          sessaoId: sessionId,
          atendimentoId: target.attendanceId,
          disciplina: target.disciplineName,
          inicio: target.startAt.toISOString(),
        };
        const why = informed.trim() ? 'com o motivo informado' : `com o motivo "${DEFAULT_REASON}"`;
        if (!confirmed) {
          return {
            status: 'preview',
            summary:
              `Vai desmarcar a sessão de ${target.disciplineName} de ${bahiaWhen(target.startAt)} (horário da Bahia), ` +
              `${why}. Não registra falta.`,
            details,
          };
        }
        // `absence` é fixo em false no cliente: falta nunca é registrada daqui.
        await this.attemptWrite(holder, () => this.siasb.unscheduleSession(session, sessionId, reason), sessionId);
        const after = await this.reread(session, from, to);
        const still = after?.find((s) => s.id === sessionId);
        const verified = after !== null && (!still || !isMarked(still.statusLabel));
        return {
          status: 'done',
          summary:
            'O SIASB aceitou o pedido para desmarcar a sessão.' +
            (verified
              ? ' Conferimos na agenda: ela não está mais marcada.'
              : ' Mas não deu para confirmar na agenda agora; confira em clinica_sessoes ou no site do SIASB.'),
          details: { ...details, verificado: verified },
        };
      },
      { mapError: mapWriteError },
    );
    return this.finish(userId, 'unschedule', () => attendanceId, run, holder, sessionId);
  }

  async addProcedure(
    userId: string,
    i: { attendanceId: string; serviceId: string; teeth?: string; faces?: string; observacao?: string; confirmed: boolean },
  ): Promise<WriteOutcome> {
    const attendanceId = requireId(i.attendanceId, 'id do atendimento');
    const serviceId = requireId(i.serviceId, 'id do procedimento do catálogo');
    const teeth = checkShort(i.teeth, 'O dente');
    const faces = checkShort(i.faces, 'A face');
    const observation = checkFreeText(i.observacao, 'A observação');
    const confirmed = i.confirmed === true;
    const holder: AttemptHolder = { attempt: null };

    const run = this.runner.run(
      userId,
      async (session): Promise<WriteOutcome> => {
        await this.requireActive(session, attendanceId);
        const service = (await this.siasb.procedures(session, attendanceId)).find((p) => p.id === serviceId);
        if (!service) {
          throw new WriteInputError(
            'Esse procedimento não está no catálogo deste atendimento. Confira em clinica_contexto_agendamento.',
          );
        }
        const details: Record<string, unknown> = {
          atendimentoId: attendanceId,
          servicoId: serviceId,
          procedimento: service.name,
          ...(teeth ? { dente: teeth } : {}),
          ...(faces ? { face: faces } : {}),
        };
        if (!confirmed) {
          return {
            status: 'preview',
            summary:
              `Vai incluir o procedimento ${serviceId} (${service.name}) no atendimento ${attendanceId}` +
              (teeth ? `, dente ${teeth}` : '') +
              (faces ? `, face ${faces}` : '') +
              '. Ficará como PREVISTO; para realizar, use o site.' +
              (observation ? ' Vai com a observação informada.' : ''),
            details,
          };
        }
        let createdId: string | null = null;
        await this.attemptWrite(holder, async () => {
          const r = await this.siasb.addProcedure(session, attendanceId, {
            serviceId: Number(serviceId),
            teeth,
            faces,
            observation,
          });
          createdId = r.createdId && isDigits(r.createdId) ? r.createdId : null;
          return r;
        });
        if (createdId && holder.attempt) holder.attempt.target = createdId;
        return {
          status: 'done',
          summary:
            `O SIASB incluiu o procedimento ${serviceId} (${service.name}) como PREVISTO.` +
            (createdId
              ? ` O id do procedimento incluído é ${createdId}.`
              : ' O SIASB não devolveu o id do procedimento incluído; para excluí-lo é preciso o id, então, se precisar, exclua pelo site.'),
          details: { ...details, procedimentoId: createdId },
        };
      },
      { mapError: mapWriteError },
    );
    return this.finish(userId, 'procedure_add', attendanceId, run, holder);
  }

  async removeProcedure(
    userId: string,
    i: { attendanceId: string; procedureId: string; confirmed: boolean },
  ): Promise<WriteOutcome> {
    const attendanceId = requireId(i.attendanceId, 'id do atendimento');
    const procedureId = requireId(i.procedureId, 'id do procedimento');
    const confirmed = i.confirmed === true;
    const holder: AttemptHolder = { attempt: null };

    const run = this.runner.run(
      userId,
      async (session): Promise<WriteOutcome> => {
        await this.requireActive(session, attendanceId);
        const details = { atendimentoId: attendanceId, procedimentoId: procedureId };
        if (!confirmed) {
          return {
            status: 'preview',
            summary: `Vai excluir o procedimento previsto de id ${procedureId} do atendimento ${attendanceId}.`,
            details,
          };
        }
        await this.attemptWrite(holder, 
          () => this.siasb.removeProcedure(session, attendanceId, procedureId),
          procedureId,
        );
        return {
          status: 'done',
          summary: `O SIASB excluiu o procedimento previsto de id ${procedureId} do atendimento ${attendanceId}.`,
          details,
        };
      },
      { mapError: mapWriteError },
    );
    return this.finish(userId, 'procedure_remove', attendanceId, run, holder, procedureId);
  }

  private async requireActive(session: SiasbSession, attendanceId: string): Promise<ClinicalAttendance> {
    const found = (await this.siasb.attendances(session, 'active')).find((a) => a.id === attendanceId);
    if (!found) throw new WriteInputError(ATTENDANCE_NOT_FOUND);
    return found;
  }

  /**
   * A única chamada de escrita de cada operação: uma tentativa, sem retry. Guarda o resultado para a auditoria e
   * deixa o SiasbError seguir para o `mapError` do executor.
   */
  private async attemptWrite(holder: AttemptHolder, write: () => Promise<unknown>, target?: string): Promise<void> {
    try {
      await write();
      holder.attempt = { result: 'ok', target };
    } catch (e) {
      const result: SiasbWriteResult =
        e instanceof SiasbError && e.code === 'WRITE_REJECTED'
          ? 'rejected'
          : e instanceof SiasbError && e.code === 'WRITE_UNKNOWN'
            ? 'unknown'
            : 'error';
      holder.attempt = { result, target };
      throw e;
    }
  }

  /** Releitura de conferência: falha aqui nunca transforma uma escrita aceita em erro (vira `verificado: false`). */
  private async reread(session: SiasbSession, from: Date, to: Date): Promise<ClinicalSession[] | null> {
    try {
      return await this.siasb.sessions(session, from, to);
    } catch {
      return null;
    }
  }

  /** Espera a operação, audita a tentativa de escrita (se houve) e, se o SIASB pode ter gravado, ressincroniza. */
  private async finish(
    userId: string,
    kind: SiasbWriteKind,
    attendanceId: string | (() => string | undefined),
    run: Promise<WriteOutcome>,
    holder: AttemptHolder,
    target?: string,
  ): Promise<WriteOutcome> {
    let outcome: WriteOutcome;
    try {
      outcome = await run;
    } catch (e) {
      if (holder.attempt) await this.afterWrite(userId, kind, attendanceId, holder.attempt, target);
      throw e;
    }
    if (holder.attempt) await this.afterWrite(userId, kind, attendanceId, holder.attempt, target);
    return outcome;
  }

  private async afterWrite(
    userId: string,
    kind: SiasbWriteKind,
    attendanceId: string | (() => string | undefined),
    attempt: WriteAttempt,
    fallbackTarget?: string,
  ): Promise<void> {
    try {
      await this.audit.record({
        userId,
        kind,
        attendanceId: typeof attendanceId === 'function' ? attendanceId() : attendanceId,
        targetId: attempt.target ?? fallbackTarget,
        result: attempt.result,
        at: this.now(),
      });
    } catch {
      /* auditoria é melhor esforço: nunca troca o resultado da escrita e nada é logado */
    }
    if (attempt.result === 'ok' || attempt.result === 'unknown') await this.resync(userId);
  }

  /**
   * Ressincroniza a cópia na hora (melhor esforço, nunca lança). Se não der `OK` (ou lançar), marca a pessoa como
   * devida para o cron. Limitação conhecida: se uma sincronização do cron estiver EM CURSO (`BUSY`), o `recordAttempt`
   * dela, ao terminar, regrava `nextRunAt` e apaga esta marcação; a cópia então só reflete a escrita na rodada normal
   * seguinte do cron (e a sincronização em curso pode já ter lido o estado anterior à escrita).
   */
  private async resync(userId: string): Promise<void> {
    let result: string | null = null;
    try {
      result = await this.syncer.syncUser(userId);
    } catch {
      result = null;
    }
    if (result === 'OK') return;
    try {
      await this.copy.markDue(userId);
    } catch {
      /* melhor esforço */
    }
  }
}
