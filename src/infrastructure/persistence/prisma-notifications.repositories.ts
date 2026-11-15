import { Injectable } from '@nestjs/common';
import {
  AlertLogRepository,
  NotificationSettingRepository,
  PushDeviceRepository,
  type NewPushDevice,
  type PushDeviceRow,
} from '../../application/ports/notifications';
import { PrismaService } from './prisma.service';

const toRow = (r: {
  id: string;
  userId: string;
  label: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  subscriptionCiphertext: string;
  subscriptionIv: string;
  subscriptionAuthTag: string;
}): PushDeviceRow => ({
  id: r.id,
  userId: r.userId,
  label: r.label,
  createdAt: r.createdAt,
  lastSuccessAt: r.lastSuccessAt,
  secret: { ciphertext: r.subscriptionCiphertext, iv: r.subscriptionIv, authTag: r.subscriptionAuthTag },
});

/** Aparelhos (`push_devices`). A assinatura fica cifrada; em claro só o sha256 do endpoint. `DELETE /me` apaga por cascade. */
@Injectable()
export class PrismaPushDeviceRepository extends PushDeviceRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findByEndpointHash(hash: string) {
    const r = await this.prisma.pushDevice.findUnique({ where: { endpointHash: hash }, select: { id: true, userId: true } });
    return r ?? null;
  }

  count(userId: string) {
    return this.prisma.pushDevice.count({ where: { userId } });
  }

  async list(userId: string) {
    return (await this.prisma.pushDevice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(toRow);
  }

  async find(userId: string, id: string) {
    const r = await this.prisma.pushDevice.findFirst({ where: { id, userId } });
    return r ? toRow(r) : null;
  }

  async create(d: NewPushDevice) {
    try {
      await this.prisma.pushDevice.create({
        data: {
          id: d.id,
          userId: d.userId,
          endpointHash: d.endpointHash,
          subscriptionCiphertext: d.secret.ciphertext,
          subscriptionIv: d.secret.iv,
          subscriptionAuthTag: d.secret.authTag,
          label: d.label,
          createdAt: d.createdAt,
        },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // endpoint já registrado (corrida)
      throw e;
    }
  }

  async setLabel(userId: string, id: string, label: string | null) {
    await this.prisma.pushDevice.updateMany({ where: { id, userId }, data: { label } });
  }

  async delete(userId: string, id: string) {
    return (await this.prisma.pushDevice.deleteMany({ where: { id, userId } })).count > 0;
  }

  async deleteById(id: string) {
    await this.prisma.pushDevice.deleteMany({ where: { id } });
  }

  async touchSuccess(id: string, at: Date) {
    await this.prisma.pushDevice.updateMany({ where: { id }, data: { lastSuccessAt: at } });
  }
}

/** Interruptores por tipo de aviso (`notification_settings`). Só chave e valor. */
@Injectable()
export class PrismaNotificationSettingRepository extends NotificationSettingRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(userId: string) {
    return (await this.prisma.notificationSetting.findMany({ where: { userId } })).map((r) => ({ key: r.key, enabled: r.enabled }));
  }

  async set(userId: string, key: string, enabled: boolean, at: Date) {
    await this.prisma.notificationSetting.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, enabled, updatedAt: at },
      update: { enabled, updatedAt: at },
    });
  }
}

/** Registro anti-duplicata (`alert_log`). A reivindicação é UM insert com `skipDuplicates`: quem gravou (count 1) envia. */
@Injectable()
export class PrismaAlertLogRepository extends AlertLogRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async claim(userId: string, key: string, subject: string, slotAt: Date, sentAt: Date, suppressed: boolean) {
    const r = await this.prisma.alertLog.createMany({ data: [{ userId, key, subject, slotAt, sentAt, suppressed }], skipDuplicates: true });
    return r.count === 1;
  }

  async release(userId: string, key: string, subject: string, slotAt: Date) {
    await this.prisma.alertLog.deleteMany({ where: { userId, key, subject, slotAt } });
  }

  async lastSentAt(userId: string, key: string, subject: string) {
    const r = await this.prisma.alertLog.findFirst({ where: { userId, key, subject, suppressed: false }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
    return r?.sentAt ?? null;
  }
}
