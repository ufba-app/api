import type {
  ReadRepository,
  SourceAccountRecord,
  SourceAccountRepository,
} from '../ports/repositories';
import { LeituraService } from './leitura.service';

const acct = (provider: string, lastSyncedAt: Date | null) =>
  ({ provider, lastSyncedAt }) as SourceAccountRecord;

describe('LeituraService', () => {
  const t1 = new Date('2026-10-01T10:00:00Z');
  const t2 = new Date('2026-10-02T10:00:00Z');
  const read = {
    listItems: jest.fn(async () => []),
    listEvents: jest.fn(async () => []),
    listChanges: jest.fn(async () => []),
    listCourseSpaces: jest.fn(async () => []),
    getProfile: jest.fn(async () => null),
    getTranscript: jest.fn(async () => ({ importedAt: t1, data: { x: 1 } })),
  } as unknown as ReadRepository;
  const accounts = {
    listByUser: async () => [acct('MOODLE', t1), acct('CLASSROOM', t2), acct('SIGAA', null)],
  } as unknown as SourceAccountRepository;
  const svc = new LeituraService(read, accounts);

  it('devolve atualizadoEm da última sincronização (e filtra por fonte)', async () => {
    expect((await svc.listarItens({ userId: 'u' })).atualizadoEm).toEqual(t2);
    expect((await svc.listarItens({ userId: 'u', provider: 'MOODLE' })).atualizadoEm).toEqual(t1);
    expect((await svc.perfil('u')).atualizadoEm).toEqual(t2);
  });

  it('agenda junta prazos e eventos; mudanças e histórico também trazem a data', async () => {
    const a = await svc.agenda({ userId: 'u', de: t1, ate: t2 });
    expect(a.dados).toEqual({ prazos: [], eventos: [] });
    expect(a.atualizadoEm).toEqual(t2);
    expect((await svc.mudancas({ userId: 'u', desde: t1 })).atualizadoEm).toEqual(t2);
    expect(await svc.historico('u')).toEqual({ atualizadoEm: t1, dados: { x: 1 } });
  });

  it('nunca sincronizado => atualizadoEm null', async () => {
    const never = new LeituraService(read, {
      listByUser: async () => [acct('SIGAA', null)],
    } as unknown as SourceAccountRepository);
    expect((await never.perfil('u')).atualizadoEm).toBeNull();
  });
});
