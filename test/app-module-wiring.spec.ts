import { Test } from '@nestjs/testing';
import { ConsultaService } from '../src/application/live/consulta.service';
import { LiveSources } from '../src/application/ports/live-source';
import { CofreSigaa } from '../src/application/sigaa/cofre-sigaa';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service';
import { SessoesSigaa } from '../src/infrastructure/sources/sigaa/sessoes-sigaa';
import { SigaaLive } from '../src/infrastructure/sources/sigaa/sigaa-live';

/**
 * O grafo de DI do AppModule real resolve (só o Prisma é trocado, para não abrir banco): `ConsultaService` recebe o
 * `CofreSigaa` e o `LiveSources` de produção tem o `SigaaLive`. Só compila: nenhuma rota sobe, nenhuma rede.
 */
describe('AppModule: ligação do SIGAA ao vivo', () => {
  it('resolve ConsultaService, CofreSigaa, SessoesSigaa e registra o SigaaLive', async () => {
    process.env.SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    const { AppModule } = await import('../src/app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(mod.get(ConsultaService)).toBeInstanceOf(ConsultaService);
    expect(mod.get(CofreSigaa)).toBeInstanceOf(CofreSigaa);
    expect(mod.get(SessoesSigaa)).toBeInstanceOf(SessoesSigaa);
    expect(mod.get(LiveSources).get('SIGAA')).toBeInstanceOf(SigaaLive);
    await mod.close();
  });
});
