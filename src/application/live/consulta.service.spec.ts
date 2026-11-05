import type { LiveSource } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import type { SigaaCredentialRecord, SigaaCredentialRepository, SourceAccountRecord } from '../ports/repositories';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';
import { CofreSigaa } from '../sigaa/cofre-sigaa';
import {
  ConsultaService,
  ContaAmbiguaError,
  FonteNaoConectadaError,
  FonteSemLeituraError,
  type Quem,
} from './consulta.service';

/** Quem chama com chave de API `plt_` (sem cliente OAuth). */
const U1: Quem = { userId: 'u1' };

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
  const cofre = { situacao: async () => null } as never;
  return { svc: new ConsultaService(live, accounts, cipher, cofre), vistos, setStatus };
}

describe('ConsultaService: uma conta por consulta', () => {
  it('uma conta só: dispensa `conta`', async () => {
    const { svc, vistos } = build([conta('a@x')]);
    await expect(svc.listarCursos(U1, 'CLASSROOM')).resolves.toEqual([{ id: '1', nome: 'curso de a@x' }]);
    expect(vistos).toEqual(['a@x/rt-a@x']);
  });

  it('várias contas: lê SÓ a pedida (sem diferenciar maiúsculas)', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x')]);
    await svc.listarCursos(U1, 'CLASSROOM', 'B@X');
    expect(vistos).toEqual(['b@x/rt-b@x']);
  });

  it('várias contas sem `conta`: erro que lista as contas, sem chamar a fonte', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x')]);
    const err = await svc.listarCursos(U1, 'CLASSROOM').catch((e) => e);
    expect(err).toBeInstanceOf(ContaAmbiguaError);
    expect(err.message).toContain('a@x, b@x');
    expect(vistos).toEqual([]);
  });

  it('conta que não está conectada: erro, sem chamar a fonte', async () => {
    const { svc, vistos } = build([conta('a@x')]);
    await expect(svc.listarCursos(U1, 'CLASSROOM', 'z@x')).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(vistos).toEqual([]);
  });

  it('token recusado: marca SÓ aquela conta e pede para reconectar', async () => {
    const { svc, setStatus } = build([conta('a@x'), conta('b@x')], 'a@x');
    await expect(svc.listarCursos(U1, 'CLASSROOM', 'a@x')).rejects.toThrow('(a@x) recusou o acesso');
    expect(setStatus).toHaveBeenCalledWith('id-a@x', 'REAUTH_NEEDED', 'REAUTH_NEEDED');
  });

  it('nenhuma conta: não conectado', async () => {
    const { svc } = build([conta('a@x', 'CLASSROOM', false)]);
    await expect(svc.prazos(U1, 'CLASSROOM')).rejects.toThrow('não conectado');
  });

  it('contas: só as com acesso guardado e de fontes com leitura ao vivo, sem chamar fonte', async () => {
    const { svc, vistos } = build([conta('a@x'), conta('b@x', 'CLASSROOM', false), conta('sigaa', 'SIGAA')]);
    await expect(svc.contas(U1)).resolves.toEqual([{ provider: 'CLASSROOM', conta: 'a@x', status: 'OK' }]);
    expect(vistos).toEqual([]);
  });

  it('ver_aviso em fonte sem verAviso: FonteSemLeituraError, sem chamar a fonte', async () => {
    const { svc, vistos } = build([conta('a@x')]);
    await expect(svc.verAviso(U1, 'CLASSROOM', undefined, 'av1')).rejects.toBeInstanceOf(FonteSemLeituraError);
    expect(vistos).toEqual([]);
  });
});

// ---- SIGAA: a senha vem do cofre, aberta com a chave K que veio no token do cliente ----

const SENHA = 'senha-falsa-de-teste';
const K = Buffer.alloc(32, 7);

/** Cifra falsa: o "cifrado" só abre com a mesma K (basta para o teste; a real é AES-GCM). */
const cifra = (k: Buffer) => ({
  encrypt: (s: string) => ({ ciphertext: `${k.toString('hex')}|${s}`, iv: '', authTag: '' }),
  decrypt: (e: { ciphertext: string }) => {
    const [kh, s] = e.ciphertext.split('|');
    if (kh !== k.toString('hex')) throw new Error('Unsupported state or unable to authenticate data');
    return s;
  },
});

function buildSigaa(opts: { comCredencial?: boolean; status?: 'OK' | 'REAUTH_NEEDED'; falha?: SourceError } = {}) {
  const chamadas: SourceContext[] = [];
  const registrar = async (ctx: SourceContext) => {
    chamadas.push(ctx);
    if (opts.falha) throw opts.falha;
  };
  const source: LiveSource = {
    provider: 'SIGAA',
    listarCursos: async (ctx) => (await registrar(ctx), [{ id: 't1', nome: 'Cálculo' }]),
    prazos: async (ctx) => (await registrar(ctx), []),
    verCurso: async (ctx) => (await registrar(ctx), []),
    verForum: async (ctx) => (await registrar(ctx), []),
    baixar: async (ctx) => (await registrar(ctx), {}) as never,
    verAviso: async (ctx, id) => (await registrar(ctx), { id, titulo: 'Prova remarcada', anexos: [] }),
  };
  const live = new LiveSources();
  live.register(source);
  let rec: SigaaCredentialRecord | null =
    opts.comCredencial === false
      ? null
      : {
          id: 'cred1',
          userId: 'u1',
          clientId: 'c1',
          login: 'aluno',
          secret: cifra(K).encrypt(SENHA),
          status: opts.status ?? 'OK',
          createdAt: new Date(),
        };
  const setStatus = jest.fn(async (_id: string, status: 'OK' | 'REAUTH_NEEDED') => {
    if (rec) rec = { ...rec, status };
  });
  const repo = {
    find: async (u: string, c: string) => (rec && rec.userId === u && rec.clientId === c ? rec : null),
    setStatus,
    upsert: async () => rec!,
  } as unknown as SigaaCredentialRepository;
  const cofre = new CofreSigaa(repo, cifra);
  const accounts = { findByUserAndProvider: async () => [], listByUser: async () => [], setStatus: jest.fn() } as never;
  const cipher = { decrypt: () => 'nunca' } as never;
  return { svc: new ConsultaService(live, accounts, cipher, cofre), chamadas, setStatus };
}

const COM_CHAVE: Quem = { userId: 'u1', cliente: { clientId: 'c1', chave: K } };
const NAO_CONECTADO = 'SIGAA não conectado neste aplicativo: conecte na tela de autorização do serviço';

describe('ConsultaService: SIGAA com a credencial do cliente', () => {
  it('SIGAA sem chave no token: erro de não conectado e zero chamadas à fonte', async () => {
    const { svc, chamadas } = buildSigaa();
    const err = await svc.listarCursos({ userId: 'u1', cliente: { clientId: 'c1' } }, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toBe(NAO_CONECTADO);
    expect(chamadas).toEqual([]);
  });

  it('chave de API plt_ (sem cliente): mesmo erro', async () => {
    const { svc, chamadas } = buildSigaa();
    for (const consulta of [
      () => svc.listarCursos(U1, 'SIGAA'),
      () => svc.prazos(U1, 'SIGAA'),
      () => svc.verCurso(U1, 'SIGAA', undefined, 't1'),
      () => svc.verForum(U1, 'SIGAA', undefined, 'f1'),
      () => svc.verAviso(U1, 'SIGAA', undefined, 'av1'),
    ]) {
      const err = await consulta().catch((e) => e);
      expect(err).toBeInstanceOf(FonteNaoConectadaError);
      expect(err.message).toBe(NAO_CONECTADO);
    }
    expect(chamadas).toEqual([]);
  });

  it('com chave mas sem credencial guardada para o cliente: mesmo erro, sem chamar a fonte', async () => {
    const { svc, chamadas } = buildSigaa({ comCredencial: false });
    await expect(svc.prazos(COM_CHAVE, 'SIGAA')).rejects.toThrow(NAO_CONECTADO);
    expect(chamadas).toEqual([]);
  });

  it('com chave: a fonte recebe credentials kind password', async () => {
    const { svc, chamadas } = buildSigaa();
    await expect(svc.listarCursos(COM_CHAVE, 'SIGAA')).resolves.toEqual([{ id: 't1', nome: 'Cálculo' }]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      userId: 'u1',
      accountKey: 'sigaa:aluno',
      sessaoKey: 'u1:c1',
      credentials: { kind: 'password', username: 'aluno', password: SENHA },
    });
  });

  it('chave errada: não conectado, sem vazar nada e sem chamar a fonte', async () => {
    const { svc, chamadas } = buildSigaa();
    const outra: Quem = { userId: 'u1', cliente: { clientId: 'c1', chave: Buffer.alloc(32, 9) } };
    const err = await svc.prazos(outra, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(err.message).not.toContain(SENHA);
    expect(err.message).not.toContain(K.toString('hex'));
    expect(chamadas).toEqual([]);
  });

  it('credencial já marcada inválida: pede para reconectar, sem chamar a fonte', async () => {
    const { svc, chamadas } = buildSigaa({ status: 'REAUTH_NEEDED' });
    const err = await svc.prazos(COM_CHAVE, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(chamadas).toEqual([]);
  });

  it('SIGAA recusa login e senha: marca a credencial e pede para reconectar, sem vazar a senha', async () => {
    const { svc, setStatus } = buildSigaa({ falha: new SourceError('REAUTH_NEEDED', 'login recusado') });
    const err = await svc.prazos(COM_CHAVE, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(err.message).not.toContain(SENHA);
    expect(setStatus).toHaveBeenCalledWith('cred1', 'REAUTH_NEEDED');
  });

  it('outra falha da fonte passa adiante sem marcar a credencial', async () => {
    const { svc, setStatus } = buildSigaa({ falha: new SourceError('UNAVAILABLE', 'SIGAA fora do ar') });
    await expect(svc.prazos(COM_CHAVE, 'SIGAA')).rejects.toBeInstanceOf(SourceError);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('`conta` diferente do login conectado: não conectado, sem chamar a fonte', async () => {
    const { svc, chamadas } = buildSigaa();
    await expect(svc.prazos(COM_CHAVE, 'SIGAA', 'outro')).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(chamadas).toEqual([]);
    await expect(svc.prazos(COM_CHAVE, 'SIGAA', 'ALUNO')).resolves.toEqual([]);
    expect(chamadas).toHaveLength(1);
  });

  it('listar_contas mostra o SIGAA do cliente', async () => {
    const { svc, chamadas } = buildSigaa();
    await expect(svc.contas(COM_CHAVE)).resolves.toEqual([{ provider: 'SIGAA', conta: 'aluno', status: 'OK' }]);
    // chave plt_ (sem cliente) ou outro cliente: não aparece
    await expect(svc.contas(U1)).resolves.toEqual([]);
    await expect(svc.contas({ userId: 'u1', cliente: { clientId: 'c2' } })).resolves.toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it('ver_aviso no SIGAA usa a fonte', async () => {
    const { svc } = buildSigaa();
    await expect(svc.verAviso(COM_CHAVE, 'SIGAA', undefined, 'av1')).resolves.toMatchObject({ id: 'av1' });
  });

  it('SIGAA não tem download nem conta de token nesta etapa', async () => {
    const { svc, chamadas } = buildSigaa();
    await expect(svc.conta(COM_CHAVE, 'SIGAA')).rejects.toBeInstanceOf(FonteSemLeituraError);
    await expect(svc.baixar(COM_CHAVE, 'SIGAA', undefined, 'ref')).rejects.toBeInstanceOf(FonteSemLeituraError);
    expect(chamadas).toEqual([]);
  });
});
