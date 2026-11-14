import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../generated/prisma/client';

/**
 * Cliente Prisma 7 com o adapter `pg`. Conecta de forma preguiçosa (na primeira consulta).
 * `?schema=x` na `DATABASE_URL` é traduzido para a opção `schema` do adapter (docs/ARQUITETURA.md §3.3).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const raw = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/platform';
    const url = new URL(raw);
    const schema = url.searchParams.get('schema') ?? undefined;
    url.searchParams.delete('schema');
    super({
      adapter: new PrismaPg({ connectionString: url.toString() }, schema ? { schema } : undefined),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
