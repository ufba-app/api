import type { LiveSource } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';
import { ConsultaService, ContaAmbiguaError, FonteNaoConectadaError } from './consulta.service';

function conta(accountKey: string, provider: Provider = 'CLASSROOM', secret = true): SourceAccountRecord {
  return {
    id: `id-${accountKey}`,
    userId: 'u1',
    provider,
    accountKey,
    siteUrl: null,
    status: 'OK',
    lastSyncedAt: null,
    secret: secret ? { ciphertext: `rt-${accountKey}`, iv: '', authTag: '' } : null,
  };
}

function build(contas: SourceAccountRecord[], falha?: string) {
  const vistos: string[] = [];
  const source: LiveSource = {
    provider: 'CLASSROOM',
    listarCursos: async (ctx: SourceContext) => {
      vistos.push(`${ctx.accountKey}/${(ctx.credentials as { token: string }).token}`);
      if (ctx.accountKey === falha) throw new SourceError('REAUTH_NEEDED', 'token recusado');
      return [{ id: '1', nome: `curso de ${ctx.accountKey}` }];
    },
    prazos: async () => [],
    verCurso: async () => [],
    verForum: async () => [],
    baixar: async () => ({}) as never,
  };
  const live = new LiveSources();
  live.register(source);
  const setStatus = jest.fn().mockResolvedValue(undefined);
  const accounts = {
    findByUserAndProvider: async (_u: string, p: Provider) => contas.filter((c) => c.provider === p),
    listByUser: async () => contas,
    setStatus,
  } as never;
  const cipher = { decrypt: (s: { ciphertext: string }) => s.ciphertext } as never;
  return { svc: new ConsultaService(live, accounts, cipher), vistos, setStatus };
}

describe('ConsultaService: uma conta por consulta', () => {
  it('uma conta só: dispensa `conta`', async () => {
    const { svc, vistos } = build([conta('a@x')]);
    await expect(svc.listarCursos('u1', 'CLASSROOM')).resolves.toEqual([{ id: '1', nome: 'curso de a@x' }]);
    expect(vistos).toEqual(['a@x/rt-a@x']);
  });

  it('várias contas: lê SÓ a pedida (sem diferenciar maiúsculas)', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x')]);
    await svc.listarCursos('u1', 'CLASSROOM', 'B@X');
    expect(vistos).toEqual(['b@x/rt-b@x']);
  });

  it('várias contas sem `conta`: erro que lista as contas, sem chamar a fonte', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x')]);
    const err = await svc.listarCursos('u1', 'CLASSROOM').catch((e) => e);
    expect(err).toBeInstanceOf(ContaAmbiguaError);
    expect(err.message).toContain('a@x, b@x');
    expect(vistos).toEqual([]);
  });

  it('conta que não está conectada: erro, sem chamar a fonte', async () => {
    const { svc, vistos } = build([conta('a@x')]);
    await expect(svc.listarCursos('u1', 'CLASSROOM', 'z@x')).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(vistos).toEqual([]);
  });

  it('token recusado: marca SÓ aquela conta e pede para reconectar', async () => {
    const { svc, setStatus } = build([conta('a@x'), conta('b@x')], 'a@x');
    await expect(svc.listarCursos('u1', 'CLASSROOM', 'a@x')).rejects.toThrow('(a@x) recusou o acesso');
    expect(setStatus).toHaveBeenCalledWith('id-a@x', 'REAUTH_NEEDED', 'REAUTH_NEEDED');
  });

  it('nenhuma conta: não conectado', async () => {
    const { svc } = build([conta('a@x', 'CLASSROOM', false)]);
    await expect(svc.prazos('u1', 'CLASSROOM')).rejects.toThrow('não conectado');
  });

  it('contas: só as com acesso guardado e de fontes com leitura ao vivo, sem chamar fonte', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x', 'CLASSROOM', false), conta('sigaa', 'SIGAA')]);
    await expect(svc.contas('u1')).resolves.toEqual([{ provider: 'CLASSROOM', conta: 'a@x', status: 'OK' }]);
    expect(vistos).toEqual([]);
  });
});
