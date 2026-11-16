import { AlertLogRepository, PushSender } from '../ports/notifications';
import type { NotificationKey } from '../web/contract';
import { NotificationSettings } from './notification-settings.service';
import { PushDevices } from './push-devices.service';

export type NotifyResult = 'sent' | 'duplicate' | 'disabled' | 'no_device' | 'unavailable' | 'failed';

export interface NotifyMessage {
  key: NotificationKey;
  /** Identifica sobre o que é o aviso (ex.: o id da disciplina). Entra no registro anti-duplicata: SEM dado pessoal de terceiros. */
  subject: string;
  /** O instante planejado do aviso: com `key` e `subject`, é a chave da anti-duplicata. */
  slotAt: Date;
  title: string;
  body: string;
  /** Um aviso novo com a mesma `tag` substitui o anterior no aparelho. */
  tag: string;
  /** Caminho no painel (começa com `/`) ou https; outro valor é ignorado. */
  url?: string;
}

const TTL_SECONDS = 6 * 3600;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const safeUrl = (u: string | undefined) => (u && (/^\/(?!\/)/.test(u) || /^https:\/\//.test(u)) ? clip(u, 500) : undefined);

/**
 * Canal de avisos genérico: qualquer fonte chama `send`. Respeita o canal ligado (`unavailable`), o ajuste da pessoa
 * (`disabled`) e a existência de aparelho (`no_device`). É NEUTRO quanto a horário: não há silêncio aqui. Horário de
 * aviso é regra de quem avisa (o SIASB decide no próprio `AlertProvider`, com `domain/notifications/quiet-hours.ts`),
 * e um aviso por gatilho (algo que acabou de acontecer) sai na hora. A anti-duplicata é atômica: o instante é reivindicado (insert com chave única)
 * ANTES de enviar, e só quem gravou envia (`duplicate` para os outros). No máximo uma vez: se nenhum aparelho recebeu, o
 * instante é devolvido (`failed`) para uma nova tentativa. NUNCA lança, nunca loga endpoint, chaves nem o texto do aviso.
 * O conteúdo é de quem envia: sem dado de paciente.
 */
export class Notifier {
  constructor(
    private readonly sender: PushSender,
    private readonly settings: NotificationSettings,
    private readonly devices: PushDevices,
    private readonly log: AlertLogRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(userId: string, m: NotifyMessage): Promise<NotifyResult> {
    let claimed = false;
    try {
      if (!this.sender.enabled) return 'unavailable';
      if (!(await this.settings.isEnabled(userId, m.key))) return 'disabled';
      const at = this.now();
      const devices = await this.devices.active(userId);
      if (devices.length === 0) return 'no_device';
      if (!(await this.log.claim(userId, m.key, m.subject, m.slotAt, at, false))) return 'duplicate';
      claimed = true;

      const payload = JSON.stringify({ title: clip(m.title, 120), body: clip(m.body, 400), tag: clip(m.tag, 64), url: safeUrl(m.url) });
      const results = await Promise.all(
        devices.map(async (d) => {
          const outcome = await this.sender.send(d.subscription, payload, { ttlSeconds: TTL_SECONDS, urgency: 'high' });
          if (outcome === 'ok') await this.devices.markSuccess(d.id);
          if (outcome === 'gone') await this.devices.drop(d.id);
          return outcome;
        }),
      );
      if (results.includes('ok')) return 'sent';
      await this.log.release(userId, m.key, m.subject, m.slotAt);
      return results.includes('failed') ? 'failed' : 'no_device';
    } catch {
      if (claimed) await this.log.release(userId, m.key, m.subject, m.slotAt).catch(() => undefined);
      return 'failed';
    }
  }

  /** Marca o instante como avisado sem enviar (ex.: avisos vencidos que não valem mais). `true` = gravou, `false` = já existia. */
  async record(userId: string, key: NotificationKey, subject: string, slotAt: Date, opts: { suppressed: boolean }): Promise<boolean> {
    return this.log.claim(userId, key, subject, slotAt, this.now(), opts.suppressed);
  }

  /** Quando saiu o último aviso de verdade (ignora os marcados sem enviar). */
  lastSentAt(userId: string, key: NotificationKey, subject: string): Promise<Date | null> {
    return this.log.lastSentAt(userId, key, subject);
  }

  async hasDevices(userId: string): Promise<boolean> {
    return (await this.devices.active(userId)).length > 0;
  }
}
