import { Injectable } from '@nestjs/common';
import {
  DeviceAuthorizationRecord,
  DeviceAuthorizationRepository,
  DeviceStatus,
  MemoryComputerRecord,
  MemoryComputerRepository,
} from '../../application/memory/device-ports';
import { PrismaService } from './prisma.service';

type DeviceRow = Omit<DeviceAuthorizationRecord, 'status'> & { status: string };

const toDevice = (r: DeviceRow): DeviceAuthorizationRecord => ({ ...r, status: r.status as DeviceStatus });

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';

@Injectable()
export class PrismaDeviceAuthorizationRepository extends DeviceAuthorizationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(rec: DeviceAuthorizationRecord): Promise<boolean> {
    try {
      await this.prisma.deviceAuthorization.create({ data: rec });
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  async findByDeviceHash(hash: string) {
    const r = await this.prisma.deviceAuthorization.findUnique({ where: { deviceCodeHash: hash } });
    return r ? toDevice(r) : null;
  }

  async findByUserHash(hash: string) {
    const r = await this.prisma.deviceAuthorization.findUnique({ where: { userCodeHash: hash } });
    return r ? toDevice(r) : null;
  }

  async findByTokenHash(hash: string) {
    const r = await this.prisma.deviceAuthorization.findUnique({ where: { tokenHash: hash } });
    return r ? toDevice(r) : null;
  }

  countActiveByIp(ip: string, now: Date): Promise<number> {
    return this.prisma.deviceAuthorization.count({
      where: { requestIp: ip, expiresAt: { gt: now }, status: { in: ['pending', 'approved'] } },
    });
  }

  async touchPoll(hash: string, v: { lastPolledAt: Date; intervalSec: number; pollCount: number }): Promise<void> {
    await this.prisma.deviceAuthorization.updateMany({ where: { deviceCodeHash: hash }, data: v });
  }

  async decide(userHash: string, userId: string, status: 'approved' | 'denied', now: Date): Promise<boolean> {
    const { count } = await this.prisma.deviceAuthorization.updateMany({
      where: { userCodeHash: userHash, status: 'pending', expiresAt: { gt: now } },
      data: { status, userId },
    });
    return count === 1;
  }

  async issueToken(deviceHash: string, tokenHash: string, tokenExpiresAt: Date, now: Date): Promise<boolean> {
    const { count } = await this.prisma.deviceAuthorization.updateMany({
      where: { deviceCodeHash: deviceHash, status: 'approved', expiresAt: { gt: now } },
      data: { status: 'issued', tokenHash, tokenExpiresAt },
    });
    return count === 1;
  }

  async consume(deviceHash: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.deviceAuthorization.updateMany({
      where: { deviceCodeHash: deviceHash, status: 'issued', tokenExpiresAt: { gt: now } },
      data: { status: 'consumed' },
    });
    return count === 1;
  }

  async deleteExpired(before: Date): Promise<void> {
    await this.prisma.deviceAuthorization.deleteMany({ where: { expiresAt: { lt: before } } });
  }
}

@Injectable()
export class PrismaMemoryComputerRepository extends MemoryComputerRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async insert(rec: MemoryComputerRecord): Promise<void> {
    await this.prisma.memoryComputer.create({ data: rec });
  }

  find(id: string): Promise<MemoryComputerRecord | null> {
    return this.prisma.memoryComputer.findUnique({ where: { id } });
  }

  listForUser(userId: string): Promise<MemoryComputerRecord[]> {
    return this.prisma.memoryComputer.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  countActive(userId: string): Promise<number> {
    return this.prisma.memoryComputer.count({ where: { userId, revokedAt: null } });
  }

  async reissue(
    id: string,
    v: {
      credentialId: string;
      keyPreview: string | null;
      name: string;
      os: string;
      agents: string[];
      clientVersion: string | null;
      installMode: string | null;
      at: Date;
    },
  ): Promise<void> {
    const { at, ...data } = v;
    await this.prisma.memoryComputer.update({ where: { id }, data: { ...data, confirmedAt: null, createdAt: at } });
  }

  async confirm(id: string, userId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.memoryComputer.updateMany({
      where: { id, userId, revokedAt: null },
      data: { confirmedAt: at },
    });
    return count === 1;
  }

  async rename(id: string, userId: string, name: string): Promise<boolean> {
    const { count } = await this.prisma.memoryComputer.updateMany({ where: { id, userId }, data: { name } });
    return count === 1;
  }

  async markRevoked(id: string, at: Date): Promise<void> {
    await this.prisma.memoryComputer.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
  }

  listUnconfirmed(before: Date, userId?: string): Promise<MemoryComputerRecord[]> {
    return this.prisma.memoryComputer.findMany({
      where: { confirmedAt: null, revokedAt: null, createdAt: { lt: before }, ...(userId ? { userId } : {}) },
    });
  }
}
