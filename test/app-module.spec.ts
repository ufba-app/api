import { Test } from '@nestjs/testing';
import { SourceRegistry } from '../src/application/ports/source-gateway';

describe('AppModule', () => {
  it('resolve todas as dependências (sem conectar ao banco)', async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x?schema=platform';
    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod.get(SourceRegistry)).toBeInstanceOf(SourceRegistry);
    await mod.close();
  });
});
