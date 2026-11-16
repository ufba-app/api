import { Injectable } from '@nestjs/common';
import type { Provider } from '../../application/ports/source-gateway';
import { SourceHealthRepository, type SourceHealthRow } from '../../application/ports/source-health';
import { PrismaService } from './prisma.service';

/** `source_health`: só metadados de saúde por conta. `DELETE /me` apaga por cascade. */
@Injectable()
export class PrismaSourceHealthRepository extends SourceHealthRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(userId: string): Promise<SourceHealthRow[]> {
    const rows = await this.prisma.sourceHealth.findMany({ where: { userId } });
    return rows.map((r) => ({
      provider: r.provider as Provider,
      accountKey: r.accountKey,
      state: r.state === 'failing' ? 'failing' : 'ok',
      reason: r.reason,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
    }));
  }

  async recordSuccess(userId: string, provider: Provider, accountKey: string, at: Date): Promise<void> {
    await this.prisma.sourceHealth.upsert({
      where: { userId_provider_accountKey: { userId, provider, accountKey } },
      create: { userId, provider, accountKey, state: 'ok', reason: null, lastSuccessAt: at },
      update: { state: 'ok', reason: null, lastSuccessAt: at },
    });
  }

  async recordFailure(userId: string, provider: Provider, accountKey: string, reason: string, at: Date): Promise<void> {
    await this.prisma.sourceHealth.upsert({
      where: { userId_provider_accountKey: { userId, provider, accountKey } },
      create: { userId, provider, accountKey, state: 'failing', reason, lastFailureAt: at },
      update: { state: 'failing', reason, lastFailureAt: at },
    });
  }
}
