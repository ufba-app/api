import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ALERT_PROVIDERS, type AlertProvider } from '../src/application/notifications/alert-provider';
import { SiasbAlertProvider } from '../src/application/siasb/siasb-alert-provider';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';

describe('ALERT_PROVIDERS', () => {
  it('tem exatamente o provedor do SIASB', async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    const providers = mod.get<AlertProvider[]>(ALERT_PROVIDERS, { strict: false });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(SiasbAlertProvider);
    expect(providers[0].key).toBe('siasb');
    await mod.close();
  });
});

describe('alias siasb-job', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  it('não existe mais e nada o importa', () => {
    expect(existsSync(join(__dirname, '..', 'src', 'siasb-job.ts'))).toBe(false);
    const files = [...walk(join(__dirname, '..', 'src')), ...walk(__dirname)].filter(
      (f) => f.endsWith('.ts') && !f.endsWith('alert-providers-wiring.spec.ts'),
    );
    const offenders = files.filter((f) => /siasb-job/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
