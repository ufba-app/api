import { NotificationSettingRepository } from '../ports/notifications';
import { NOTIFICATION_KEYS, type NotificationKey } from '../web/contract';
import { NOTIFICATION_CATALOG } from './catalog';

export interface NotificationSettingItem {
  key: NotificationKey;
  source: string;
  title: string;
  description: string;
  enabled: boolean;
}

/** Ajustes por tipo de aviso, dirigidos pelo catálogo. Sem linha = `defaultEnabled`. */
export class NotificationSettings {
  constructor(
    private readonly repo: NotificationSettingRepository,
    private readonly now: () => Date = () => new Date(),
    /** Sem ele, nada é filtrado (testes). */
    private readonly access?: { hasAccess(userId: string, source: string): Promise<boolean> },
  ) {}

  /** Só os avisos de fontes a que a pessoa tem acesso (quem não tem SIASB não vê os avisos dele). */
  async list(userId: string): Promise<NotificationSettingItem[]> {
    const rows = new Map((await this.repo.list(userId)).map((r) => [r.key, r.enabled]));
    const allowed = new Map<string, boolean>();
    for (const s of new Set(NOTIFICATION_KEYS.map((k) => NOTIFICATION_CATALOG[k].source))) {
      allowed.set(s, this.access ? await this.access.hasAccess(userId, s) : true);
    }
    return NOTIFICATION_KEYS.filter((k) => allowed.get(NOTIFICATION_CATALOG[k].source)).map((key) => {
      const def = NOTIFICATION_CATALOG[key];
      return { key, source: def.source, title: def.title, description: def.description, enabled: rows.get(key) ?? def.defaultEnabled };
    });
  }

  async isEnabled(userId: string, key: NotificationKey): Promise<boolean> {
    const row = (await this.repo.list(userId)).find((r) => r.key === key);
    return row ? row.enabled : NOTIFICATION_CATALOG[key].defaultEnabled;
  }

  async set(userId: string, key: NotificationKey, enabled: boolean): Promise<void> {
    await this.repo.set(userId, key, enabled, this.now());
  }
}
