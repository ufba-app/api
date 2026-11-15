import { bahiaDateKey, bahiaDayAndHour, bahiaWeekday } from '../../domain/siasb/alert-format';
import { alertChain, chainSlotAtOrBefore, latestDue, unscheduledSlot, ALERT_GAP_MS } from '../../domain/siasb/alert-schedule';
import { inQuietHours } from '../../domain/notifications/quiet-hours';
import type { AlertResult } from '../notifications/alert-provider';
import type { Notifier, NotifyResult } from '../notifications/notifier';
import type { SourceAccountRepository } from '../ports/repositories';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import type { SiasbCopyReader } from './siasb-copy-reader';
import type { DisciplineSituation } from './situation';

const KEY = 'siasb.alerts' as const;
const TITLE = 'SIASB';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A cópia só vale para avisar de prazo se o último sucesso tem até 24 h. */
const COPY_MAX_AGE_MS = 24 * HOUR;
/** "Prazo perdido" só até 72 h depois do prazo (nunca um aviso velho depois de uma queda). */
const MISSED_MAX_AGE_MS = 72 * HOUR;
const RECONNECT_SUBJECT = 'connection';
const RECONNECT_BEFORE_MS = [7 * DAY, 3 * DAY, 1 * DAY];

/**
 * Instantes do aviso de reconexão (função pura): `vencimento − 7 d`, `− 3 d`, `− 1 d`, o próprio vencimento e depois a
 * cada 36 h desde ele. Só `> after` (exclusivo) e `<= upTo`, do mais antigo ao mais recente. Um instante que cai no
 * silêncio NÃO é movido: `evaluateUser` não faz nada no silêncio e o aviso é reavaliado na rodada seguinte.
 */
export function reconnectSlots(expiresAt: Date, after: Date, upTo: Date): Date[] {
  const e = expiresAt.getTime();
  const ms = RECONNECT_BEFORE_MS.map((b) => e - b);
  ms.push(e);
  const kMin = Math.max(1, Math.floor((after.getTime() - e) / ALERT_GAP_MS));
  const kMax = Math.floor((upTo.getTime() - e) / ALERT_GAP_MS);
  for (let k = kMin; k <= kMax; k++) ms.push(e + k * ALERT_GAP_MS);
  return ms
    .filter((m) => m > after.getTime() && m <= upTo.getTime())
    .sort((a, b) => a - b)
    .map((m) => new Date(m));
}

const deadlineSubject = (disciplineId: string, deadline: Date) => `disc:${disciplineId}:${bahiaDateKey(deadline)}`;

/**
 * Decide e envia os avisos de prazo (por disciplina) e de reconexão (por pessoa) pelo `Notifier`. Lê só o banco (a cópia).
 * Os instantes dependem só do prazo (ou do vencimento), nunca do momento do envio, então duas rodadas calculam as mesmas
 * chaves e a anti-duplicata atômica do Notifier garante um aviso por instante. Nenhum texto, subject ou tag leva dado
 * de paciente; o nome da disciplina é o único dado vindo do SIASB.
 */
export class SiasbAlerts {
  constructor(
    private readonly copyReader: SiasbCopyReader,
    private readonly copy: SiasbCopyRepository,
    private readonly notifier: Notifier,
    private readonly accounts: SourceAccountRepository,
  ) {}

  /** Avalia os avisos de UMA pessoa em `now`. NUNCA lança (uma exceção vira `failed`, sem mensagem registrada). */
  async evaluateUser(userId: string, now: Date): Promise<AlertResult> {
    const r: AlertResult = { sent: 0, suppressed: 0, skipped: 0, failed: 0 };
    try {
      if (!(await this.notifier.hasDevices(userId))) return { ...r, skipped: 1 };
    } catch {
      return { ...r, failed: 1 };
    }
    // O silêncio 22h-7h é daqui (não do Notifier): nada é enviado nem registrado (nem suppressed) e o que está devido
    // espera a próxima rodada. Vale para todo aviso (prazo, sem horário, prazo perdido e reconexão).
    if (inQuietHours(now)) return { ...r, skipped: 1 };
    try {
      await this.deadlineAlerts(userId, now, r);
    } catch {
      r.failed++;
    }
    try {
      await this.reconnectAlert(userId, now, r);
    } catch {
      r.failed++;
    }
    return r;
  }

  // ── envio ──────────────────────────────────────────────────────────────────

  private async deliver(userId: string, r: AlertResult, subject: string, slotAt: Date, body: string): Promise<NotifyResult> {
    const res = await this.notifier.send(userId, { key: KEY, subject, slotAt, title: TITLE, body, tag: `siasb-${subject}`, url: '/' });
    switch (res) {
      case 'sent':
        r.sent++;
        break;
      case 'failed':
        r.failed++;
        break;
      default:
        r.skipped++;
    }
    return res;
  }

  /** Só depois de um envio (ou duplicata) os instantes pulados viram "avisados sem enviar". */
  private async suppress(userId: string, r: AlertResult, subject: string, slots: Date[]): Promise<void> {
    for (const s of slots) if (await this.notifier.record(userId, KEY, subject, s, { suppressed: true })) r.suppressed++;
  }

  // ── prazo ──────────────────────────────────────────────────────────────────

  private async deadlineAlerts(userId: string, now: Date, r: AlertResult): Promise<void> {
    const state = await this.copy.state(userId);
    const trusted =
      state !== null &&
      state.result !== 'RECONNECT_REQUIRED' &&
      state.lastSuccessAt !== null &&
      now.getTime() - state.lastSuccessAt.getTime() <= COPY_MAX_AGE_MS;
    if (!trusted) {
      r.skipped++;
      return;
    }
    const situation = await this.copyReader.situation(userId);
    if (situation.syncedAt === null) {
      r.skipped++;
      return;
    }
    for (const item of situation.items) {
      if (item.state === 'SCHEDULED') continue;
      if (item.deadline) await this.deadlineItem(userId, item, item.deadline, now, r);
      else if (item.state === 'NO_PATIENT') await this.unscheduledItem(userId, item, now, r);
      await this.missedDeadline(userId, item, situation.previous?.[item.disciplineId] ?? null, now, r);
    }
  }

  private async deadlineItem(userId: string, item: DisciplineSituation, deadline: Date, now: Date, r: AlertResult): Promise<void> {
    const subject = deadlineSubject(item.disciplineId, deadline);
    const last = await this.notifier.lastSentAt(userId, KEY, subject);
    const body = this.deadlineBody(item, deadline);
    if (last === null) {
      await this.deliver(userId, r, subject, chainSlotAtOrBefore(deadline, now) ?? new Date(Math.floor(now.getTime() / HOUR) * HOUR), body);
    } else {
      const { due, skipped } = latestDue(alertChain(deadline, last, now), now);
      if (due) {
        const res = await this.deliver(userId, r, subject, due, body);
        if (res === 'sent' || res === 'duplicate') await this.suppress(userId, r, subject, skipped);
      }
    }
  }

  /**
   * "Prazo perdido": o horário anterior da clínica (vindo da leitura, função pura) teve o prazo vencido há até 72 h,
   * a pessoa foi avisada naquele episódio, ainda está sem paciente/sessão (① ou ②) e não há sessão válida no dia do
   * horário (marcou e atendeu não é perdido). slotAt = o prazo perdido; o texto cita a próxima chance, se houver.
   */
  private async missedDeadline(
    userId: string,
    item: DisciplineSituation,
    previous: { slot: Date; deadline: Date; covered: boolean } | null,
    now: Date,
    r: AlertResult,
  ): Promise<void> {
    if (!previous || previous.covered) return;
    const age = now.getTime() - previous.deadline.getTime();
    if (age <= 0 || age > MISSED_MAX_AGE_MS) return;
    const subject = deadlineSubject(item.disciplineId, previous.deadline);
    if ((await this.notifier.lastSentAt(userId, KEY, subject)) === null) return;
    const next =
      item.deadline && item.deadline.getTime() > previous.deadline.getTime()
        ? ` Próxima chance: ${bahiaDayAndHour(item.deadline)}.`
        : '';
    await this.deliver(userId, r, subject, previous.deadline, `Prazo perdido em ${item.disciplineName}.${next}`);
  }

  private deadlineBody(item: DisciplineSituation, deadline: Date): string {
    const day = item.nextSlot ? bahiaWeekday(item.nextSlot) : bahiaWeekday(deadline);
    const limit = bahiaDayAndHour(deadline);
    if (item.state === 'NO_SESSION') {
      return `Você tem paciente em ${item.disciplineName}, mas a clínica de ${day} ainda está sem sessão. Prazo estimado: ${limit}.`;
    }
    return `Você ainda não tem paciente em ${item.disciplineName}, e a clínica de ${day} está sem sessão. Cadastre ou pegue um paciente e marque até ${limit} (prazo estimado).`;
  }

  private async unscheduledItem(userId: string, item: DisciplineSituation, now: Date, r: AlertResult): Promise<void> {
    const subject = `disc:${item.disciplineId}:unscheduled`;
    const last = await this.notifier.lastSentAt(userId, KEY, subject);
    const slot = last === null ? new Date(Math.floor(now.getTime() / HOUR) * HOUR) : unscheduledSlot(last, now);
    if (!slot) return;
    await this.deliver(
      userId,
      r,
      subject,
      slot,
      `Você ainda não tem paciente nem sessão marcada em ${item.disciplineName}. Confira os horários no SIASB.`,
    );
  }

  // ── reconexão ──────────────────────────────────────────────────────────────

  private async reconnectAlert(userId: string, now: Date, r: AlertResult): Promise<void> {
    const accounts = await this.accounts.findByUserAndProvider(userId, 'SIASB');
    const expiresAt = accounts.map((a) => a.expiresAt).find((e): e is Date => e !== null) ?? null;
    if (!expiresAt) return;
    const last = await this.notifier.lastSentAt(userId, KEY, RECONNECT_SUBJECT);
    const after = last ?? new Date(expiresAt.getTime() - 8 * DAY);
    const { due, skipped } = latestDue(reconnectSlots(expiresAt, after, now), now);
    if (!due) return;
    const left = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY));
    const body =
      now.getTime() >= expiresAt.getTime()
        ? 'Seu acesso ao SIASB venceu. Reconecte no painel.'
        : `Seu acesso ao SIASB vence em ${left} ${left === 1 ? 'dia' : 'dias'}. Reconecte no painel.`;
    const res = await this.deliver(userId, r, RECONNECT_SUBJECT, due, body);
    if (last !== null && (res === 'sent' || res === 'duplicate')) await this.suppress(userId, r, RECONNECT_SUBJECT, skipped);
  }
}
