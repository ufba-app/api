import { Secret } from '../shared/secret';
import type { FrequenciaViva, LiveSource } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';
import { CofreSigaa } from '../sigaa/cofre-sigaa';
import { InMemoryCredentials, InMemoryVaults, cifraDeTeste as cifra } from '../../../test/support/sigaa-store-fake';
import {
  ConsultaService,
  ContaAmbiguaError,
  FonteNaoConectadaError,
  FonteSemLeituraError,
  MAX_ANEXOS_DE_PASTAS,
  MAX_PASTAS,
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
    expiresAt: null,
    secret: secret ? { ciphertext: `rt-${accountKey}`, iv: '', authTag: '' } : null,
  };
}

function build(contas: SourceAccountRecord[], falha?: string, drive?: import('../ports/drive-downloader').DriveDownloader) {
  const vistos: string[] = [];
  const source: LiveSource = {
    provider: 'CLASSROOM',
    listarCursos: async (ctx: SourceContext) => {
      vistos.push(`${ctx.accountKey}/${(ctx.credentials as { token: Secret }).token.reveal()}`);
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
  return { svc: new ConsultaService(live, accounts, cipher, cofre, drive), vistos, setStatus };
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
const FREQUENCIA: FrequenciaViva = {
  cursoId: 't1',
  cursoNome: 'Cálculo',
  presencas: 21,
  aulasRegistradas: 29,
  aulasCH: 32,
  completa: true,
};

async function buildSigaa(
  opts: {
    comCredencial?: boolean;
    status?: 'OK' | 'REAUTH_NEEDED';
    falha?: SourceError;
    sessaoViva?: boolean;
    semFrequencia?: boolean;
    saude?: import('./source-health-recorder').SourceHealthRecorder;
  } = {},
) {
  const chamadas: SourceContext[] = [];
  const aberturas: string[] = [];
  // Como o corretor de sessão real: só abre a senha (com a K do cliente) quando precisa logar.
  const registrar = async (ctx: SourceContext) => {
    if (!opts.sessaoViva && ctx.credentials.kind === 'password-on-demand') {
      aberturas.push((await ctx.credentials.open()).reveal());
    }
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
    ...(opts.semFrequencia ? {} : { frequencia: async (ctx: SourceContext) => (await registrar(ctx), [FREQUENCIA]) }),
  };
  const live = new LiveSources();
  live.register(source);
  const repo = new InMemoryCredentials();
  const vaults = new InMemoryVaults();
  const cofre = new CofreSigaa(repo, vaults, cifra);
  const setStatus = jest.spyOn(vaults, 'setStatus');
  if (opts.comCredencial !== false) {
    await cofre.gravar({ userId: 'u1', clientId: 'c1' }, { login: 'aluno', senha: Secret.of(SENHA) }, K);
    if (opts.status === 'REAUTH_NEEDED') await cofre.marcarInvalida('u1');
    setStatus.mockClear();
  }
  const accounts = { findByUserAndProvider: async () => [], listByUser: async () => [], setStatus: jest.fn() } as never;
  const cipher = { decrypt: () => 'nunca' } as never;
  return { svc: new ConsultaService(live, accounts, cipher, cofre, undefined, opts.saude), chamadas, aberturas, setStatus };
}

const COM_CHAVE: Quem = { userId: 'u1', cliente: { clientId: 'c1', chave: K } };
const NAO_CONECTADO = 'SIGAA não conectado neste aplicativo: conecte na tela de autorização do serviço';

describe('ConsultaService: SIGAA registra a saúde por conta (sigaa:<login>)', () => {
  const gravador = () => {
    const gravado: unknown[][] = [];
    const repo = {
      list: async () => [],
      recordSuccess: async (...a: unknown[]) => void gravado.push(['ok', ...a]),
      recordFailure: async (...a: unknown[]) => void gravado.push(['fail', ...a]),
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SourceHealthRecorder } = require('./source-health-recorder');
    return { gravado, saude: new SourceHealthRecorder(repo) };
  };

  it('leitura ok grava ok; SIGAA fora do ar grava source_unavailable; senha recusada não grava', async () => {
    const a = gravador();
    await (await buildSigaa({ saude: a.saude })).svc.listarCursos(COM_CHAVE, 'SIGAA');
    expect(a.gravado).toEqual([['ok', 'u1', 'SIGAA', 'sigaa:aluno', expect.any(Date)]]);

    const b = gravador();
    const fora = await buildSigaa({ saude: b.saude, falha: new SourceError('UNAVAILABLE', 'fora') });
    await fora.svc.listarCursos(COM_CHAVE, 'SIGAA').catch(() => undefined);
    expect(b.gravado).toEqual([['fail', 'u1', 'SIGAA', 'sigaa:aluno', 'source_unavailable', expect.any(Date)]]);

    const c = gravador();
    const recusada = await buildSigaa({ saude: c.saude, falha: new SourceError('REAUTH_NEEDED', 'recusou') });
    await recusada.svc.listarCursos(COM_CHAVE, 'SIGAA').catch(() => undefined);
    expect(c.gravado).toEqual([]);
  });
});

describe('ConsultaService: SIGAA com a credencial do cliente', () => {
  it('SIGAA sem chave no token: erro de não conectado e zero chamadas à fonte', async () => {
    const { svc, chamadas } = await buildSigaa();
    const err = await svc.listarCursos({ userId: 'u1', cliente: { clientId: 'c1' } }, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toBe(NAO_CONECTADO);
    expect(chamadas).toEqual([]);
  });

  it('chave de API plt_ (sem cliente): mesmo erro', async () => {
    const { svc, chamadas } = await buildSigaa();
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
    const { svc, chamadas } = await buildSigaa({ comCredencial: false });
    await expect(svc.prazos(COM_CHAVE, 'SIGAA')).rejects.toThrow(NAO_CONECTADO);
    expect(chamadas).toEqual([]);
  });

  it('com chave: a fonte recebe a senha sob demanda (kind password-on-demand), que abre com a K do cliente', async () => {
    const { svc, chamadas, aberturas } = await buildSigaa();
    await expect(svc.listarCursos(COM_CHAVE, 'SIGAA')).resolves.toEqual([{ id: 't1', nome: 'Cálculo' }]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      userId: 'u1',
      accountKey: 'sigaa:aluno',
      credentials: { kind: 'password-on-demand', username: 'aluno', open: expect.any(Function) },
    });
    expect(aberturas).toEqual([SENHA]);
  });

  it('com sessão viva a senha nunca é aberta (K só é usada quando precisa logar)', async () => {
    const { svc, chamadas, aberturas } = await buildSigaa({ sessaoViva: true });
    await expect(svc.listarCursos(COM_CHAVE, 'SIGAA')).resolves.toEqual([{ id: 't1', nome: 'Cálculo' }]);
    await expect(svc.prazos(COM_CHAVE, 'SIGAA')).resolves.toEqual([]);
    expect(chamadas).toHaveLength(2);
    expect(aberturas).toEqual([]);
  });

  it('chave errada: não conectado, sem vazar nada e sem chamar a fonte', async () => {
    const { svc, chamadas } = await buildSigaa();
    const outra: Quem = { userId: 'u1', cliente: { clientId: 'c1', chave: Buffer.alloc(32, 9) } };
    const err = await svc.prazos(outra, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(err.message).not.toContain(SENHA);
    expect(err.message).not.toContain(K.toString('hex'));
    expect(chamadas).toEqual([]);
  });

  it('credencial já marcada inválida: pede para reconectar, sem chamar a fonte', async () => {
    const { svc, chamadas } = await buildSigaa({ status: 'REAUTH_NEEDED' });
    const err = await svc.prazos(COM_CHAVE, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(chamadas).toEqual([]);
  });

  it('SIGAA recusa login e senha: marca a credencial e pede para reconectar, sem vazar a senha', async () => {
    const { svc, setStatus } = await buildSigaa({ falha: new SourceError('REAUTH_NEEDED', 'login recusado') });
    const err = await svc.prazos(COM_CHAVE, 'SIGAA').catch((e) => e);
    expect(err).toBeInstanceOf(FonteNaoConectadaError);
    expect(err.message).toContain('conecte o SIGAA de novo');
    expect(err.message).not.toContain(SENHA);
    expect(setStatus).toHaveBeenCalledWith('u1', 'REAUTH_NEEDED');
  });

  it('outra falha da fonte passa adiante sem marcar a credencial', async () => {
    const { svc, setStatus } = await buildSigaa({ falha: new SourceError('UNAVAILABLE', 'SIGAA fora do ar') });
    await expect(svc.prazos(COM_CHAVE, 'SIGAA')).rejects.toBeInstanceOf(SourceError);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('`conta` diferente do login conectado: não conectado, sem chamar a fonte', async () => {
    const { svc, chamadas } = await buildSigaa();
    await expect(svc.prazos(COM_CHAVE, 'SIGAA', 'outro')).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(chamadas).toEqual([]);
    await expect(svc.prazos(COM_CHAVE, 'SIGAA', 'ALUNO')).resolves.toEqual([]);
    expect(chamadas).toHaveLength(1);
  });

  it('listar_contas mostra o SIGAA do cliente', async () => {
    const { svc, chamadas } = await buildSigaa();
    await expect(svc.contas(COM_CHAVE)).resolves.toEqual([{ provider: 'SIGAA', conta: 'aluno', status: 'OK' }]);
    // chave plt_ (sem cliente) ou outro cliente: não aparece
    await expect(svc.contas(U1)).resolves.toEqual([]);
    await expect(svc.contas({ userId: 'u1', cliente: { clientId: 'c2' } })).resolves.toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it('ver_aviso no SIGAA usa a fonte', async () => {
    const { svc } = await buildSigaa();
    await expect(svc.verAviso(COM_CHAVE, 'SIGAA', undefined, 'av1')).resolves.toMatchObject({ id: 'av1' });
  });

  it('frequência no SIGAA usa a fonte, com a senha sob demanda aberta com a K do cliente', async () => {
    const { svc, chamadas, aberturas } = await buildSigaa();
    await expect(svc.frequencia(COM_CHAVE)).resolves.toEqual([FREQUENCIA]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].credentials).toMatchObject({ kind: 'password-on-demand', username: 'aluno' });
    expect(aberturas).toEqual([SENHA]);
  });

  it('frequência sem chave no token (plt_): não conectado, sem chamar a fonte', async () => {
    const { svc, chamadas } = await buildSigaa();
    await expect(svc.frequencia(U1)).rejects.toThrow(NAO_CONECTADO);
    expect(chamadas).toEqual([]);
  });

  it('frequência com fonte SIGAA sem `frequencia`: FonteSemLeituraError, sem chamar a fonte', async () => {
    const { svc, chamadas } = await buildSigaa({ semFrequencia: true });
    await expect(svc.frequencia(COM_CHAVE)).rejects.toBeInstanceOf(FonteSemLeituraError);
    expect(chamadas).toEqual([]);
  });

  it('SIGAA não tem download nem conta de token nesta etapa', async () => {
    const { svc, chamadas } = await buildSigaa();
    await expect(svc.conta(COM_CHAVE, 'SIGAA')).rejects.toBeInstanceOf(FonteSemLeituraError);
    await expect(svc.baixar(COM_CHAVE, 'SIGAA', undefined, 'ref')).rejects.toBeInstanceOf(FonteSemLeituraError);
    expect(chamadas).toEqual([]);
  });
});

describe('ConsultaService: arquivos do Drive linkados no Moodle', () => {
  it('ref do Drive vai ao DriveDownloader com as contas do Google da pessoa (token só em memória) e NÃO ao Moodle', async () => {
    const chamadas: Array<{ userId: string; ref: string; contas: string[] }> = [];
    const drive = {
      owns: (r: string) => r.startsWith('gdrive1.'),
      download: async (userId: string, ref: string, contas: ReadonlyArray<{ accountKey: string; refreshToken: { reveal(): string } }>) => {
        chamadas.push({ userId, ref, contas: contas.map((c) => `${c.accountKey}/${c.refreshToken.reveal()}`) });
        return { bytes: new Uint8Array([1]), mimeType: 'application/pdf' };
      },
    };
    const moodleBaixar = jest.fn();
    const { svc } = build([conta('ava:aluno', 'MOODLE'), conta('eu@ufba.br'), conta('eu@gmail.com'), { ...conta('velho@x'), status: 'REAUTH_NEEDED' }, conta('sem@x', 'CLASSROOM', false)], undefined, drive as never);
    // O Moodle não deve ser consultado: registra uma fonte Moodle que falha se chamada.
    (svc as unknown as { sources: LiveSources }).sources.register({ provider: 'MOODLE', baixar: moodleBaixar } as never);
    await expect(svc.baixar(U1, 'MOODLE', undefined, 'gdrive1.file.abc.sig')).resolves.toMatchObject({ mimeType: 'application/pdf' });
    expect(chamadas).toEqual([{ userId: 'u1', ref: 'gdrive1.file.abc.sig', contas: ['eu@ufba.br/rt-eu@ufba.br', 'eu@gmail.com/rt-eu@gmail.com'] }]);
    expect(moodleBaixar).not.toHaveBeenCalled();
  });

  it('confere a conta do Moodle de onde o anexo veio (sem Moodle conectado: erro, sem Drive)', async () => {
    const download = jest.fn();
    const { svc } = build([conta('eu@ufba.br')], undefined, { owns: () => true, download } as never);
    await expect(svc.baixar(U1, 'MOODLE', undefined, 'gdrive1.file.abc.sig')).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(download).not.toHaveBeenCalled();
  });

  it('ref que não é do Drive segue para o Moodle como sempre; sem DriveDownloader também', async () => {
    const baixar = jest.fn().mockResolvedValue({ bytes: new Uint8Array(), mimeType: 'text/plain' });
    const download = jest.fn();
    const mk = (drive?: unknown) => {
      const r = build([conta('ava:aluno', 'MOODLE')], undefined, drive as never);
      (r.svc as unknown as { sources: LiveSources }).sources.register({ provider: 'MOODLE', baixar } as never);
      return r.svc;
    };
    await mk({ owns: () => false, download }).baixar(U1, 'MOODLE', undefined, 'https://ava.test/pluginfile.php/1/a.pdf');
    await mk(undefined).baixar(U1, 'MOODLE', undefined, 'gdrive1.file.abc.sig');
    expect(baixar).toHaveBeenCalledTimes(2);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('ConsultaService.turmasComHorario', () => {
  it('fonte SIGAA sem a capacidade: FonteSemLeituraError, sem tocar nada', async () => {
    const { svc } = build([conta('a@x')]);
    await expect(svc.turmasComHorario(U1)).rejects.toBeInstanceOf(FonteSemLeituraError);
  });

  it('sem K no token (chave de API): SIGAA não conectado neste aplicativo', async () => {
    const { svc } = build([conta('a@x')]);
    (svc as unknown as { sources: LiveSources }).sources.register({ provider: 'SIGAA', turmasComHorario: async () => [] } as never);
    await expect(svc.turmasComHorario(U1)).rejects.toBeInstanceOf(FonteNaoConectadaError);
  });
});

describe('ConsultaService.agendaSigaa', () => {
  it('fonte SIGAA sem a capacidade: FonteSemLeituraError', async () => {
    const { svc } = build([conta('a@x')]);
    await expect(svc.agendaSigaa(U1)).rejects.toBeInstanceOf(FonteSemLeituraError);
  });

  it('sem K no token (chave de API): SIGAA não conectado neste aplicativo, sem tocar a fonte', async () => {
    const { svc } = build([conta('a@x')]);
    const agendaSigaa = jest.fn();
    (svc as unknown as { sources: LiveSources }).sources.register({ provider: 'SIGAA', agendaSigaa } as never);
    await expect(svc.agendaSigaa(U1)).rejects.toBeInstanceOf(FonteNaoConectadaError);
    expect(agendaSigaa).not.toHaveBeenCalled();
  });
});

describe('ConsultaService: pastas do Drive e conferência antes do link', () => {
  const pastaRef = 'gdrive1.folder.PASTA.sig';
  const mkDrive = (over: Record<string, unknown> = {}) => {
    const listadas: string[] = [];
    const drive = {
      owns: (r: string) => r.startsWith('gdrive1.'),
      isFolder: (r: string) => r.startsWith('gdrive1.folder.'),
      viewUrl: (_u: string, r: string) => `https://drive.google.com/drive/folders/${r.split('.')[2]}`,
      listFolder: async (_u: string, ref: string, contas: ReadonlyArray<{ accountKey: string }>) => {
        listadas.push(`${ref}|${contas.map((c) => c.accountKey).join(',')}`);
        return [
          { name: 'Aula 1.pdf', mimeType: 'application/pdf', sizeBytes: 2048, ref: 'gdrive1.file.A.sig', isFolder: false, blocked: null, viewUrl: 'https://v/a', label: 'Aula 1.pdf', message: null },
          { name: 'Aula 01.mp4', mimeType: 'video/mp4', sizeBytes: 350 * 1024 * 1024, ref: null, isFolder: false, blocked: 'video', viewUrl: 'https://v/v', label: 'Aula 01.mp4 (vídeo, 350 MB)', message: 'm' },
          { name: 'Extras', mimeType: 'application/vnd.google-apps.folder', sizeBytes: null, ref: null, isFolder: true, blocked: null, viewUrl: 'https://v/f', label: 'Extras (subpasta)', message: null },
        ];
      },
      inspect: async () => null,
      ...over,
    };
    return { drive, listadas };
  };
  const moodleCom = (atividades: unknown[], drive: unknown) => {
    const r = build([conta('ava:aluno', 'MOODLE'), conta('eu@ufba.br'), { ...conta('velho@x'), status: 'REAUTH_NEEDED' }], undefined, drive as never);
    (r.svc as unknown as { sources: LiveSources }).sources.register({ provider: 'MOODLE', verCurso: async () => atividades, verForum: async () => atividades } as never);
    return r.svc;
  };
  const item = (anexos: unknown[], extra: object = {}) => ({ id: '1', tipo: 'material', titulo: 'Slides', anexos, ...extra });

  it('a pasta vira um anexo por arquivo baixável; vídeo e subpasta vão para abrirNoNavegador com o rótulo; as contas do Google vão em memória', async () => {
    const { drive, listadas } = mkDrive();
    const svc = moodleCom([item([{ nome: 'Slides / Arquivos', ref: pastaRef }, { nome: 'outro.pdf', ref: 'https://ava.test/a.pdf' }])], drive);
    const [a] = await svc.verCurso(U1, 'MOODLE', undefined, '10');
    // Os filhos entram no lugar da pasta, na ordem em que ela aparecia.
    expect(a.anexos.map((x) => [x.nome, x.ref])).toEqual([['Aula 1.pdf', 'gdrive1.file.A.sig'], ['outro.pdf', 'https://ava.test/a.pdf']]);
    expect(a.anexos[0]).toMatchObject({ mimeType: 'application/pdf', tamanhoBytes: 2048 });
    expect(a.abrirNoNavegador).toEqual([{ nome: 'Aula 01.mp4 (vídeo, 350 MB)', url: 'https://v/v' }, { nome: 'Extras (subpasta)', url: 'https://v/f' }]);
    // Só as contas do Google em ordem de cadastro e SEM a REAUTH_NEEDED; o ref da pasta é o que foi listado.
    expect(listadas).toEqual([`${pastaRef}|eu@ufba.br`]);
    expect(JSON.stringify(a)).not.toContain('rt-'); // nenhum token na resposta
  });

  it('o mesmo vale no ver_forum', async () => {
    const { drive } = mkDrive();
    const svc = moodleCom([{ id: '9', titulo: 'x', anexos: [{ nome: 'Pasta', ref: pastaRef }] }], drive);
    const [d] = await svc.verForum(U1, 'MOODLE', undefined, '77');
    expect(d.anexos.map((x) => x.nome)).toEqual(['Aula 1.pdf']);
  });

  it('pasta que não deu para listar (null ou erro) vira só o link para a pessoa abrir; ver_curso não cai', async () => {
    for (const listFolder of [async () => null, async () => { throw new Error('boom'); }]) {
      const { drive } = mkDrive({ listFolder });
      const svc = moodleCom([item([{ nome: 'Slides', ref: pastaRef }])], drive);
      const [a] = await svc.verCurso(U1, 'MOODLE', undefined, '10');
      expect(a.anexos).toEqual([]);
      expect(a.abrirNoNavegador).toEqual([{ nome: 'Slides (não consegui listar os arquivos)', url: 'https://drive.google.com/drive/folders/PASTA' }]);
    }
  });

  it('teto de pastas expandidas por chamada: as demais viram link', async () => {
    const { drive, listadas } = mkDrive();
    const refs = Array.from({ length: MAX_PASTAS + 2 }, (_, i) => `gdrive1.folder.P${i}.sig`);
    const svc = moodleCom([item(refs.map((r, i) => ({ nome: `Pasta ${i}`, ref: r })))], drive);
    const [a] = await svc.verCurso(U1, 'MOODLE', undefined, '10');
    expect(listadas).toHaveLength(MAX_PASTAS);
    expect(a.abrirNoNavegador!.filter((l) => l.nome.endsWith('(não consegui listar os arquivos)'))).toHaveLength(2);
  });

  it('teto de anexos novos no total', async () => {
    const muitos = Array.from({ length: 150 }, (_, i) => ({ name: `f${i}`, mimeType: 'application/pdf', sizeBytes: 1, ref: `gdrive1.file.F${i}.sig`, isFolder: false, blocked: null, viewUrl: `https://v/${i}`, label: `f${i}`, message: null }));
    const { drive } = mkDrive({ listFolder: async () => muitos });
    const svc = moodleCom([item([{ nome: 'A', ref: 'gdrive1.folder.A.sig' }, { nome: 'B', ref: 'gdrive1.folder.B.sig' }])], drive);
    const [a] = await svc.verCurso(U1, 'MOODLE', undefined, '10');
    expect(a.anexos).toHaveLength(MAX_ANEXOS_DE_PASTAS);
    expect(a.abrirNoNavegador!.length).toBe(300 - MAX_ANEXOS_DE_PASTAS); // o excedente vira link
  });

  it('sem DriveDownloader, ou fonte que não é o Moodle: a lista segue como veio', async () => {
    const anexos = [{ nome: 'Pasta', ref: pastaRef }];
    const sem = moodleCom([item(anexos)], undefined);
    expect((await sem.verCurso(U1, 'MOODLE', undefined, '10'))[0].anexos).toEqual(anexos);
    const { drive, listadas } = mkDrive();
    const cl = build([conta('a@x')], undefined, drive as never);
    (cl.svc as unknown as { sources: LiveSources }).sources.register({ provider: 'CLASSROOM', verCurso: async () => [item(anexos)] } as never);
    expect((await cl.svc.verCurso(U1, 'CLASSROOM', undefined, '1'))[0].anexos).toEqual(anexos);
    expect(listadas).toEqual([]);
  });

  it('driveInfo: só para ref de arquivo do Drive; confere a conta do Moodle; erro vira null', async () => {
    const info = { name: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 5, viewUrl: 'u', blocked: 'video', message: 'm' };
    const { drive } = mkDrive({ inspect: async () => info });
    const r = build([conta('ava:aluno', 'MOODLE'), conta('eu@ufba.br')], undefined, drive as never);
    expect(await r.svc.driveInfo(U1, undefined, 'gdrive1.file.A.sig')).toEqual(info);
    expect(await r.svc.driveInfo(U1, undefined, pastaRef)).toBeNull(); // pasta não
    expect(await r.svc.driveInfo(U1, undefined, 'https://ava.test/a.pdf')).toBeNull(); // não é do Drive
    const semMoodle = build([conta('eu@ufba.br')], undefined, drive as never);
    expect(await semMoodle.svc.driveInfo(U1, undefined, 'gdrive1.file.A.sig')).toBeNull(); // Moodle não conectado
    const quebra = build([conta('ava:aluno', 'MOODLE')], undefined, mkDrive({ inspect: async () => { throw new Error('x'); } }).drive as never);
    expect(await quebra.svc.driveInfo(U1, undefined, 'gdrive1.file.A.sig')).toBeNull();
    expect(await build([conta('ava:aluno', 'MOODLE')]).svc.driveInfo(U1, undefined, 'gdrive1.file.A.sig')).toBeNull(); // sem DriveDownloader
  });
});
