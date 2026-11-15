import type { EncryptedSecret } from './repositories';

/** A assinatura Web Push do aparelho. NUNCA vai para log, erro ou resposta. */
export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushDeviceRow {
  id: string;
  userId: string;
  label: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  /** Assinatura cifrada (AAD `push:<userId>:<id>`). */
  secret: EncryptedSecret;
}

export interface NewPushDevice {
  id: string;
  userId: string;
  endpointHash: string;
  secret: EncryptedSecret;
  label: string | null;
  createdAt: Date;
}

/** Aparelhos (`push_devices`). Só o hash do endpoint fica em claro. */
export abstract class PushDeviceRepository {
  abstract findByEndpointHash(hash: string): Promise<{ id: string; userId: string } | null>;
  abstract count(userId: string): Promise<number>;
  abstract list(userId: string): Promise<PushDeviceRow[]>;
  abstract find(userId: string, id: string): Promise<PushDeviceRow | null>;
  /** `false` se o endpoint já existe (chave única): quem chamou perdeu a corrida e relê. */
  abstract create(device: NewPushDevice): Promise<boolean>;
  abstract setLabel(userId: string, id: string, label: string | null): Promise<void>;
  /** Só apaga se for da pessoa. `true` = apagou. */
  abstract delete(userId: string, id: string): Promise<boolean>;
  /** Apaga pelo id, sem olhar o dono (aparelho que o provedor disse que morreu, ou endpoint que mudou de conta). */
  abstract deleteById(id: string): Promise<void>;
  abstract touchSuccess(id: string, at: Date): Promise<void>;
}

/** Interruptores por tipo de aviso (`notification_settings`). Sem linha = padrão do catálogo. */
export abstract class NotificationSettingRepository {
  abstract list(userId: string): Promise<Array<{ key: string; enabled: boolean }>>;
  abstract set(userId: string, key: string, enabled: boolean, at: Date): Promise<void>;
}

/** Registro anti-duplicata (`alert_log`), chave única (userId, key, subject, slotAt). */
export abstract class AlertLogRepository {
  /** Reivindica o instante: `true` só para quem gravou (insert com skipDuplicates; nunca ler e depois escrever). */
  abstract claim(userId: string, key: string, subject: string, slotAt: Date, sentAt: Date, suppressed: boolean): Promise<boolean>;
  /** Devolve o instante reivindicado (o envio não chegou a nenhum aparelho): outra tentativa pode reenviar. */
  abstract release(userId: string, key: string, subject: string, slotAt: Date): Promise<void>;
  /** O envio mais recente de verdade (ignora `suppressed`). */
  abstract lastSentAt(userId: string, key: string, subject: string): Promise<Date | null>;
}

export type PushOutcome = 'ok' | 'gone' | 'failed';

/** Canal Web Push (chaves VAPID por ambiente). Desligado sem as três variáveis. */
export abstract class PushSender {
  abstract readonly enabled: boolean;
  abstract readonly publicKey: string | null;
  /** `gone` = o provedor disse que a assinatura acabou (404/410). Nunca lança. */
  abstract send(subscription: PushSubscriptionData, payload: string, options: { ttlSeconds: number; urgency: 'high' }): Promise<PushOutcome>;
}
