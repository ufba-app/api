import type { ArquivoParaEnvio, EntregaTarefa, EstadoEntrega, LiveSource, RequisitosEntrega } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import type { Provider, SourceContext } from '../ports/source-gateway';
import { ConsultaService, EntregaInvalidaError, type Quem } from './consulta.service';
import { ConfirmacoesEntrega, UploadLinks } from './entrega-links';
import { SourceError } from '../ports/source-gateway';
import { EntregaParcialError, EntregaService, LIMITES_UPLOAD, MAX_BYTES_INLINE } from './entrega.service';

const EU: Quem = { userId: 'u1' };
const OUTRA: Quem = { userId: 'u2' };
const AGORA = Date.parse('2026-11-22T12:00:00Z');
const HORA = 3_600_000;
/** Como no AVA real: o id público da atividade (cmid, de `ver_curso`) não é o id interno da tarefa (assign id). */
const CMID = '4258935';
const ASSIGN_ID = '286293';

function contaMoodle(userId: string): SourceAccountRecord {
  return {
    id: `id-${userId}`,
    userId,
    provider: 'MOODLE',
    accountKey: `${userId}@ufba.br`,
    siteUrl: 'https://ava.example',
    status: 'OK',
    lastSyncedAt: null,
    expiresAt: null,
    secret: { ciphertext: `tok-${userId}`, iv: '', authTag: '' },
  };
}

function req(over: Partial<RequisitosEntrega> = {}): RequisitosEntrega {
  return {
    tarefaId: ASSIGN_ID,
    cmid: CMID,
    titulo: 'Lista 2',
    aceitaArquivo: true,
    aceitaTexto: false,
    maxArquivos: 2,
    maxBytesPorArquivo: 1000,
    extensoes: ['.pdf', '.txt'],
    prazo: new Date(AGORA + 24 * HORA),
    limite: new Date(AGORA + 48 * HORA),
    exigeBotaoEnviar: false,
    emGrupo: false,
    exigeDeclaracao: false,
    estado: 'nova',
    podeEditar: true,
    arquivosAtuais: [],
    temTextoAtual: false,
    ...over,
  };
}

const arq = (nome: string, tamanho = 10): ArquivoParaEnvio => ({ nome, bytes: new Uint8Array(tamanho) });
/** Arquivo "grande" sem alocar: a validação só olha `bytes.length`. */
const grande = (nome: string, tamanho: number): ArquivoParaEnvio => ({ nome, bytes: { length: tamanho } as Uint8Array });
const SO_TEXTO: Partial<RequisitosEntrega> = { aceitaArquivo: false, aceitaTexto: true };
const MB = 1024 * 1024;

function montar(requisitos: RequisitosEntrega = req()) {
  let agora = AGORA;
  const clock = () => agora;
  const state = { requisitos };
  const requisitosEntrega = jest.fn(async (_ctx: SourceContext, _c: string, _t: string) => state.requisitos);
  const subirArquivosEntrega = jest.fn(async (_ctx: SourceContext, arquivos: ArquivoParaEnvio[]) => ({
    itemId: '777',
    arquivos: arquivos.map((a) => ({ nome: a.nome, tamanhoBytes: a.bytes.length })),
  }));
  const salvarEntrega = jest.fn(
    async (_ctx: SourceContext, _e: EntregaTarefa): Promise<EstadoEntrega> => ({
      estado: state.requisitos.exigeBotaoEnviar ? 'rascunho' : 'entregue',
    }),
  );
  const finalizarEntrega = jest.fn(async (_ctx: SourceContext, _t: string): Promise<EstadoEntrega> => ({ estado: 'entregue' }));
  const moodle: LiveSource = {
    provider: 'MOODLE',
    listarCursos: async () => [],
    prazos: async () => [],
    verCurso: async () => [],
    verForum: async () => [],
    baixar: async () => ({}) as never,
    requisitosEntrega,
    subirArquivosEntrega,
    salvarEntrega,
    finalizarEntrega,
  };
  const live = new LiveSources();
  live.register(moodle);
  const contas = [contaMoodle('u1'), contaMoodle('u2')];
  const accounts = {
    findByUserAndProvider: async (u: string, p: Provider) => contas.filter((c) => c.userId === u && c.provider === p),
    listByUser: async (u: string) => contas.filter((c) => c.userId === u),
    setStatus: jest.fn(),
  } as never;
  const cipher = { decrypt: (s: { ciphertext: string }) => s.ciphertext } as never;
  const cofre = { situacao: async () => null } as never;
  const consulta = new ConsultaService(live, accounts, cipher, cofre);
  const uploads = new UploadLinks(15 * 60_000, clock);
  const confirmacoes = new ConfirmacoesEntrega(10 * 60_000, clock);
  const svc = new EntregaService(consulta, uploads, confirmacoes, clock);
  const nadaEscrito = () => {
    expect(salvarEntrega).not.toHaveBeenCalled();
    expect(finalizarEntrega).not.toHaveBeenCalled();
  };
  const nadaSubido = () => expect(subirArquivosEntrega).not.toHaveBeenCalled();
  return {
    svc,
    state,
    contas,
    uploads,
    requisitosEntrega,
    subirArquivosEntrega,
    salvarEntrega,
    finalizarEntrega,
    nadaEscrito,
    nadaSubido,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
}

const PEDIDO = { cursoId: '7', tarefaId: CMID };

describe('EntregaService', () => {
  it('cmid x assign id: o caller fala em cmid; ticket e confirmação ligam ao cmid; as escritas recebem o assign id', async () => {
    const m = montar(req({ exigeBotaoEnviar: true }));
    const { uploadId } = await m.svc.preparar(EU, PEDIDO);
    expect(m.uploads.espiar(uploadId!)).toMatchObject({ cmid: CMID, cursoId: '7' });
    await m.svc.receberUpload(uploadId!, [arq('a.pdf')]);
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, uploadId });
    // A confirmação não vale com o id interno no lugar do cmid (não se confundem).
    const e = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, { cursoId: '7', tarefaId: ASSIGN_ID }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).resolves.toEqual({ estado: 'entregue', entregue: true });
    for (const call of m.requisitosEntrega.mock.calls) expect(call[2]).toBe(CMID);
    expect(m.salvarEntrega).toHaveBeenCalledWith(expect.anything(), { tarefaId: ASSIGN_ID, itemId: '777' });
    expect(m.finalizarEntrega).toHaveBeenCalledWith(expect.anything(), ASSIGN_ID);
  });

  it('a tarefa relida na confirmação com outro assign id (o cmid passou a apontar outra tarefa): recusa sem gravar', async () => {
    const m = montar(req({ ...SO_TEXTO }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    m.state.requisitos = req({ ...SO_TEXTO, tarefaId: '999' });
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });

  it('preparar devolve os requisitos e um uploadId; sem aceitaArquivo não há uploadId', async () => {
    const m = montar();
    const p = await m.svc.preparar(EU, PEDIDO);
    expect(p.requisitos.titulo).toBe('Lista 2');
    expect(p.uploadId).toEqual(expect.any(String));
    expect(p.expiraEm).toEqual(new Date(AGORA + 15 * 60_000));
    expect(m.requisitosEntrega).toHaveBeenCalledWith(expect.objectContaining({ accountKey: 'u1@ufba.br' }), '7', CMID);

    const s = montar(req({ aceitaArquivo: false }));
    const q = await s.svc.preparar(EU, PEDIDO);
    expect(q.uploadId).toBeUndefined();
    expect(q.expiraEm).toBeUndefined();
    m.nadaEscrito();
    m.nadaSubido();
  });

  it('receberUpload valida contra o ticket, sobe ao Moodle e guarda para o dono; o link é de uso único', async () => {
    const m = montar();
    const { uploadId } = await m.svc.preparar(EU, PEDIDO);
    await expect(m.svc.receberUpload(uploadId!, [arq('a.pdf', 5)])).resolves.toEqual({ arquivos: [{ nome: 'a.pdf', tamanhoBytes: 5 }] });
    expect(m.subirArquivosEntrega).toHaveBeenCalledTimes(1);
    await expect(m.svc.receberUpload(uploadId!, [arq('b.pdf')])).rejects.toBeInstanceOf(EntregaInvalidaError);
    expect(m.subirArquivosEntrega).toHaveBeenCalledTimes(1);

    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, uploadId });
    expect(r.arquivos).toEqual([{ nome: 'a.pdf', tamanhoBytes: 5 }]);
    await expect(m.svc.solicitar(OUTRA, 'enviar', { ...PEDIDO, uploadId })).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });

  it('solicitar não escreve: devolve resumo com confirmacaoId, e efeito diz "entrega" quando exigeBotaoEnviar=false', async () => {
    const m = montar();
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf', 12)] });
    expect(r.confirmacaoId).toEqual(expect.any(String));
    expect(r.expiraEm).toEqual(new Date(AGORA + 10 * 60_000));
    expect(r.acao).toBe('enviar');
    expect(r.tarefa).toBe('Lista 2');
    expect(r.arquivos).toEqual([{ nome: 'a.pdf', tamanhoBytes: 12 }]);
    expect(r.texto).toBeUndefined();
    const t = await montar(req(SO_TEXTO)).svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'minha resposta' });
    expect(t.texto).toBe('minha resposta');
    expect(r.efeito).toContain('entrega');
    expect(r.prazo).toEqual(new Date(AGORA + 24 * HORA));
    expect(r.atrasada).toBe(false);
    expect(r.substituiEntrega).toBe(false);
    m.nadaEscrito();
  });

  it('com exigeBotaoEnviar=true: rascunho → efeito "salva como rascunho"; enviar → "entrega"', async () => {
    const m = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true }));
    const rasc = await m.svc.solicitar(EU, 'rascunho', { ...PEDIDO, texto: 'x' });
    expect(rasc.efeito).toContain('salva como rascunho');
    expect(rasc.efeito).not.toContain('entrega');
    const env = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'x' });
    expect(env.efeito).toContain('entrega');
    m.nadaEscrito();
  });

  it('rascunho em tarefa sem botão é recusado, mandando usar enviar_tarefa', async () => {
    const m = montar(req({ exigeBotaoEnviar: false }));
    const e = await m.svc.solicitar(EU, 'rascunho', { ...PEDIDO, arquivos: [arq('a.pdf')] }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(EntregaInvalidaError);
    expect((e as Error).message).toContain('enviar_tarefa');
    m.nadaEscrito();
    m.nadaSubido();
  });

  it.each<[string, Partial<RequisitosEntrega>]>([
    ['em grupo', { emGrupo: true }],
    ['com declaração', { exigeDeclaracao: true }],
    ['antes de abrir', { abreEm: new Date(AGORA + HORA) }],
    ['depois do limite', { prazo: new Date(AGORA - 2 * HORA), limite: new Date(AGORA - HORA) }],
    ['entregue sem poder editar', { estado: 'entregue', podeEditar: false }],
  ])(
    'tarefa em grupo, com declaração, fora da janela (abreEm no futuro, limite no passado), entregue com podeEditar=false: EntregaInvalidaError (%s)',
    async (_nome, over) => {
      const m = montar(req(over));
      await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] })).rejects.toBeInstanceOf(EntregaInvalidaError);
      m.nadaEscrito();
      m.nadaSubido();
    },
  );

  it('depois do prazo e antes do limite: atrasada=true e segue', async () => {
    const m = montar(req({ prazo: new Date(AGORA - HORA), limite: new Date(AGORA + HORA) }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
    expect(r.atrasada).toBe(true);
    expect(r.confirmacaoId).toEqual(expect.any(String));
    m.nadaEscrito();
  });

  it('entregue com podeEditar=true: substituiEntrega=true', async () => {
    const m = montar(req({ estado: 'entregue', podeEditar: true, arquivosAtuais: [{ nome: 'velho.pdf', tamanhoBytes: 3 }] }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('novo.pdf')] });
    expect(r.substituiEntrega).toBe(true);
    expect(r.efeito).toContain('substitu');
    m.nadaEscrito();
  });

  it.each<[string, ArquivoParaEnvio[]]>([
    ['extensão', [arq('a.exe')]],
    ['sem extensão', [arq('LEIAME')]],
    ['tamanho', [arq('a.pdf', 1001)]],
    ['quantidade', [arq('a.pdf'), arq('b.pdf'), arq('c.pdf')]],
  ])('arquivo fora da extensão / maior que o limite / além de maxArquivos: recusa antes de subir (%s)', async (_nome, arquivos) => {
    const m = montar();
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos })).rejects.toBeInstanceOf(EntregaInvalidaError);
    const { uploadId } = await m.svc.preparar(EU, PEDIDO);
    await expect(m.svc.receberUpload(uploadId!, arquivos)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaSubido();
    m.nadaEscrito();
  });

  it('arquivo em tarefa que não aceita arquivo: recusa', async () => {
    const m = montar(req(SO_TEXTO));
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] })).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaSubido();
    m.nadaEscrito();
  });

  it('texto em tarefa que não aceita texto: recusa', async () => {
    const m = montar(req({ aceitaTexto: false }));
    const e = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'segredo do trabalho' }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(EntregaInvalidaError);
    expect((e as Error).message).not.toContain('segredo do trabalho');
    m.nadaEscrito();
  });

  it('pedido sem arquivo nem texto: recusa', async () => {
    const m = montar();
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO })).rejects.toBeInstanceOf(EntregaInvalidaError);
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: '   ', arquivos: [] })).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });

  it('uploadId e arquivos juntos: recusa', async () => {
    const m = montar();
    const { uploadId } = await m.svc.preparar(EU, PEDIDO);
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, uploadId, arquivos: [arq('a.pdf')] })).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaSubido();
    m.nadaEscrito();
  });

  it('uploadId de outra tarefa: recusa', async () => {
    const m = montar();
    const { uploadId } = await m.svc.preparar(EU, PEDIDO);
    await m.svc.receberUpload(uploadId!, [arq('a.pdf')]);
    m.state.requisitos = req({ tarefaId: '286294', cmid: '4258936' });
    await expect(m.svc.solicitar(EU, 'enviar', { cursoId: '7', tarefaId: '4258936', uploadId })).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });

  it('base64 acima de 2 MB: recusa', async () => {
    const m = montar(req({ maxBytesPorArquivo: undefined, maxArquivos: undefined }));
    const metade = MAX_BYTES_INLINE / 2;
    await expect(
      m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf', metade), arq('b.pdf', metade + 1)] }),
    ).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaSubido();
    m.nadaEscrito();
  });

  it('enviar sem conteúdo novo com rascunho existente e botão de enviar: resumo só finaliza', async () => {
    const m = montar(req({ exigeBotaoEnviar: true, estado: 'rascunho', arquivosAtuais: [{ nome: 'a.pdf', tamanhoBytes: 3 }] }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO });
    expect(r.efeito).toContain('entrega');
    expect(r.substituiEntrega).toBe(false);
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(m.salvarEntrega).not.toHaveBeenCalled();
    expect(m.finalizarEntrega).toHaveBeenCalledWith(expect.anything(), ASSIGN_ID);
  });

  it('confirmar enviar: salva e, com exigeBotaoEnviar=true, também finaliza; sem botão só salva (não chama finalizarEntrega)', async () => {
    const com = montar(req({ exigeBotaoEnviar: true }));
    const r1 = await com.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
    await expect(com.svc.confirmar(EU, 'enviar', r1.confirmacaoId, PEDIDO)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(com.salvarEntrega).toHaveBeenCalledWith(expect.objectContaining({ accountKey: 'u1@ufba.br' }), { tarefaId: ASSIGN_ID, itemId: '777' });
    expect(com.finalizarEntrega).toHaveBeenCalledWith(expect.anything(), ASSIGN_ID);

    const sem = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: false }));
    const r2 = await sem.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    await expect(sem.svc.confirmar(EU, 'enviar', r2.confirmacaoId, PEDIDO)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(sem.salvarEntrega).toHaveBeenCalledWith(expect.anything(), { tarefaId: ASSIGN_ID, texto: 'oi' });
    expect(sem.finalizarEntrega).not.toHaveBeenCalled();
  });

  it('confirmar rascunho: só salva', async () => {
    const m = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true }));
    const r = await m.svc.solicitar(EU, 'rascunho', { ...PEDIDO, texto: 'oi' });
    await expect(m.svc.confirmar(EU, 'rascunho', r.confirmacaoId, PEDIDO)).resolves.toEqual({ estado: 'rascunho', entregue: false });
    expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
    expect(m.finalizarEntrega).not.toHaveBeenCalled();
  });

  it('confirmar com id de outra pessoa, expirado, reutilizado ou de outra ação: EntregaInvalidaError e nada escrito', async () => {
    const m = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    await expect(m.svc.confirmar(OUTRA, 'enviar', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    await expect(m.svc.confirmar(EU, 'rascunho', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    await expect(m.svc.confirmar(EU, 'enviar', 'inexistente', PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.avancar(10 * 60_000 + 1);
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();

    const n = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true }));
    const r2 = await n.svc.solicitar(EU, 'rascunho', { ...PEDIDO, texto: 'oi' });
    await n.svc.confirmar(EU, 'rascunho', r2.confirmacaoId, PEDIDO);
    expect(n.salvarEntrega).toHaveBeenCalledTimes(1);
    await expect(n.svc.confirmar(EU, 'rascunho', r2.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    expect(n.salvarEntrega).toHaveBeenCalledTimes(1);
  });

  it('confirmar revalida a tarefa: se o limite passou desde o resumo, recusa e nada escrito', async () => {
    const m = montar(req({ ...SO_TEXTO, limite: new Date(AGORA + 60_000) }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    m.avancar(2 * 60_000);
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });

  describe('C1: tarefa que aceita arquivo E texto', () => {
    const AMBOS: Partial<RequisitosEntrega> = { aceitaArquivo: true, aceitaTexto: true, exigeBotaoEnviar: true };

    it.each<['rascunho' | 'enviar', Partial<{ texto: string; arquivos: ArquivoParaEnvio[] }>]>([
      ['rascunho', { arquivos: [arq('a.pdf')] }],
      ['rascunho', { texto: 'oi' }],
      ['enviar', { arquivos: [arq('a.pdf')] }],
      ['enviar', { texto: 'oi' }],
      ['enviar', { texto: 'oi', arquivos: [arq('a.pdf')] }],
    ])('solicitar %s é recusado com mensagem clara, sem subir nem gravar (%j)', async (acao, conteudo) => {
      const m = montar(req(AMBOS));
      const e = await m.svc.solicitar(EU, acao, { ...PEDIDO, ...conteudo }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(EntregaInvalidaError);
      expect((e as Error).message).toMatch(/aceita arquivo e texto/);
      expect((e as Error).message).toMatch(/AVA/);
      m.nadaSubido();
      m.nadaEscrito();
    });

    it('preparar diz podeEntregar=false com o motivo e não abre link de upload', async () => {
      const m = montar(req(AMBOS));
      const p = await m.svc.preparar(EU, PEDIDO);
      expect(p.podeEntregar).toBe(false);
      expect(p.motivo).toMatch(/aceita arquivo e texto/);
      expect(p.uploadId).toBeUndefined();
      expect(p.expiraEm).toBeUndefined();
    });

    it('tarefa só de arquivo e só de texto seguem normais', async () => {
      const a = montar(req({ exigeBotaoEnviar: true }));
      expect((await a.svc.preparar(EU, PEDIDO)).podeEntregar).toBe(true);
      await expect(a.svc.solicitar(EU, 'rascunho', { ...PEDIDO, arquivos: [arq('a.pdf')] })).resolves.toMatchObject({ acao: 'rascunho' });
      const t = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true }));
      expect((await t.svc.preparar(EU, PEDIDO)).podeEntregar).toBe(true);
      await expect(t.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' })).resolves.toMatchObject({ acao: 'enviar' });
    });
  });

  describe('preparar: podeEntregar, motivo, atrasada/fechada e limites', () => {
    it.each<[string, Partial<RequisitosEntrega>, RegExp]>([
      ['fechada', { prazo: new Date(AGORA - 2 * HORA), limite: new Date(AGORA - HORA) }, /prazo final/],
      ['ainda não abriu', { abreEm: new Date(AGORA + HORA) }, /ainda não está aberta/],
      ['em grupo', { emGrupo: true }, /grupo/],
      ['com declaração', { exigeDeclaracao: true }, /declaração/],
      ['sem poder editar', { podeEditar: false }, /não permite alterar/],
    ])('%s: podeEntregar=false, motivo e sem link', async (_n, over, motivo) => {
      const m = montar(req(over));
      const p = await m.svc.preparar(EU, PEDIDO);
      expect(p.podeEntregar).toBe(false);
      expect(p.motivo).toMatch(motivo);
      expect(p.uploadId).toBeUndefined();
    });

    it('atrasada e fechada calculadas pelo serviço', async () => {
      const atrasada = await montar(req({ prazo: new Date(AGORA - HORA), limite: new Date(AGORA + HORA) })).svc.preparar(EU, PEDIDO);
      expect(atrasada).toMatchObject({ atrasada: true, fechada: false, podeEntregar: true });
      expect(atrasada.uploadId).toEqual(expect.any(String));
      const fechada = await montar(req({ prazo: new Date(AGORA - 2 * HORA), limite: new Date(AGORA - HORA) })).svc.preparar(EU, PEDIDO);
      expect(fechada).toMatchObject({ atrasada: true, fechada: true, podeEntregar: false });
      const emDia = await montar(req()).svc.preparar(EU, PEDIDO);
      expect(emDia).toMatchObject({ atrasada: false, fechada: false });
    });

    it('limitesArquivos: o menor entre a tarefa e o teto do serviço (25 MB por arquivo, 50 MB por envio, 20 arquivos)', async () => {
      expect(LIMITES_UPLOAD).toEqual({ maxArquivos: 20, maxBytesPorArquivo: 25 * MB, maxBytesTotal: 50 * MB });
      const pequena = await montar(req({ maxArquivos: 2, maxBytesPorArquivo: 1000 })).svc.preparar(EU, PEDIDO);
      expect(pequena.limitesArquivos).toEqual({ maxArquivos: 2, maxBytesPorArquivo: 1000, maxBytesTotal: 50 * MB, extensoes: ['.pdf', '.txt'] });
      const enorme = await montar(req({ maxArquivos: 50, maxBytesPorArquivo: 500 * MB })).svc.preparar(EU, PEDIDO);
      expect(enorme.limitesArquivos).toMatchObject({ maxArquivos: 20, maxBytesPorArquivo: 25 * MB, maxBytesTotal: 50 * MB });
      const solta = await montar(req({ maxArquivos: undefined, maxBytesPorArquivo: undefined })).svc.preparar(EU, PEDIDO);
      expect(solta.limitesArquivos).toMatchObject({ maxArquivos: 20, maxBytesPorArquivo: 25 * MB });
      expect((await montar(req(SO_TEXTO)).svc.preparar(EU, PEDIDO)).limitesArquivos).toBeUndefined();
    });
  });

  describe('I1: tetos do serviço e reserva do link', () => {
    const SEM_LIMITE = { maxArquivos: undefined, maxBytesPorArquivo: undefined };

    it.each<[string, ArquivoParaEnvio[]]>([
      ['21 arquivos', Array.from({ length: 21 }, (_, n) => arq(`${n}.pdf`))],
      ['arquivo acima de 25 MB', [grande('a.pdf', 25 * MB + 1)]],
      ['mais de 50 MB somados', [grande('a.pdf', 20 * MB), grande('b.pdf', 20 * MB), grande('c.pdf', 11 * MB)]],
    ])('receberUpload recusa %s mesmo sem limite na tarefa', async (_n, arquivos) => {
      const m = montar(req(SEM_LIMITE));
      const { uploadId } = await m.svc.preparar(EU, PEDIDO);
      await expect(m.svc.receberUpload(uploadId!, arquivos)).rejects.toBeInstanceOf(EntregaInvalidaError);
      m.nadaSubido();
    });

    it('espiarUpload devolve os limites efetivos; reservar/liberar delegam ao link', async () => {
      const m = montar(req({ maxArquivos: 3, maxBytesPorArquivo: 2000 }));
      const { uploadId } = await m.svc.preparar(EU, PEDIDO);
      expect(m.svc.espiarUpload(uploadId!)).toEqual({ maxArquivos: 3, maxBytesPorArquivo: 2000, maxBytesTotal: 50 * MB });
      expect(m.svc.espiarUpload('nada')).toBeUndefined();
      expect(m.svc.reservarUpload(uploadId!)).toBe(true);
      expect(m.svc.reservarUpload(uploadId!)).toBe(false);
      m.svc.liberarUpload(uploadId!);
      expect(m.svc.reservarUpload(uploadId!)).toBe(true);
      await m.svc.receberUpload(uploadId!, [arq('a.pdf')]);
      expect(m.subirArquivosEntrega).toHaveBeenCalledTimes(1);
    });
  });

  describe('I4: confirmação usada com outra tarefa', () => {
    it('é recusada sem gastar e continua valendo para a tarefa certa', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      for (const alvo of [{ cursoId: '7', tarefaId: '4258936' }, { cursoId: '8', tarefaId: CMID }, { cursoId: '7', tarefaId: ASSIGN_ID }]) {
        const e = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, alvo).catch((x: Error) => x);
        expect(e).toBeInstanceOf(EntregaInvalidaError);
        expect((e as Error).message).toMatch(/outra tarefa/);
        expect((e as Error).message).toMatch(/novo resumo/);
      }
      m.nadaEscrito();
      await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).resolves.toMatchObject({ entregue: true });
      expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
    });

    it('conta diferente também é recusada sem gastar', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      m.contas.push({ ...m.contas[0], id: 'id-u1b', accountKey: 'u1b@ufba.br' });
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, conta: 'u1@ufba.br', arquivos: [arq('a.pdf')] });
      await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, { ...PEDIDO, conta: 'u1b@ufba.br' })).rejects.toThrow(/outra tarefa/);
      m.nadaEscrito();
      await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, { ...PEDIDO, conta: 'U1@ufba.br' })).resolves.toMatchObject({ entregue: true });
    });
  });

  describe('I5: a entrega mudou no AVA entre o resumo e a confirmação', () => {
    it.each<[string, Partial<RequisitosEntrega>]>([
      ['estado mudou', { estado: 'entregue' }],
      ['arquivo novo apareceu', { arquivosAtuais: [{ nome: 'outro.pdf', tamanhoBytes: 9 }] }],
      ['tamanho do arquivo mudou', { arquivosAtuais: [{ nome: 'velho.pdf', tamanhoBytes: 4 }] }],
    ])('%s: recusa sem gravar', async (_n, depois) => {
      const antes = req({ exigeBotaoEnviar: true, estado: 'rascunho', arquivosAtuais: [{ nome: 'velho.pdf', tamanhoBytes: 3 }] });
      const m = montar(antes);
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      m.state.requisitos = { ...antes, ...depois };
      const e = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO).catch((x: Error) => x);
      expect(e).toBeInstanceOf(EntregaInvalidaError);
      expect((e as Error).message).toMatch(/mudou no AVA/);
      m.nadaEscrito();
    });

    it('sem mudança: grava normalmente', async () => {
      const antes = req({ exigeBotaoEnviar: true, estado: 'rascunho', arquivosAtuais: [{ nome: 'velho.pdf', tamanhoBytes: 3 }] });
      const m = montar(antes);
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      m.state.requisitos = { ...antes, arquivosAtuais: [{ nome: 'velho.pdf', tamanhoBytes: 3 }] };
      await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).resolves.toMatchObject({ entregue: true });
    });
  });

  describe('I6: falha depois de uma escrita bem-sucedida', () => {
    it('(a) salvou e o envio para avaliação falhou: EntregaParcialError dizendo que ficou rascunho e NÃO foi enviado', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      m.finalizarEntrega.mockRejectedValueOnce(new SourceError('UNAVAILABLE', 'O Moodle não aceitou enviar a tarefa'));
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const e = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO).catch((x: Error) => x);
      expect(e).toBeInstanceOf(EntregaParcialError);
      expect((e as EntregaParcialError).code).toBe('ENTREGA_PARCIAL');
      expect((e as Error).message).toMatch(/salv[oa] como rascunho/);
      expect((e as Error).message).toMatch(/NÃO foi enviad/);
      expect((e as Error).message).toMatch(/enviar_tarefa sem conteúdo/);
      expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
      expect(m.finalizarEntrega).toHaveBeenCalledTimes(1);
    });

    it('(a) também quando a leitura depois de salvar falhou (estado ausente) e o envio falhou', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      m.salvarEntrega.mockResolvedValueOnce({});
      m.finalizarEntrega.mockRejectedValueOnce(new Error('rede'));
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO)).rejects.toBeInstanceOf(EntregaParcialError);
      expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
    });

    it('só finalizar (nada salvo agora) e o envio falhou: erro comum, sem dizer que salvou', async () => {
      const m = montar(req({ exigeBotaoEnviar: true, estado: 'rascunho', arquivosAtuais: [{ nome: 'a.pdf', tamanhoBytes: 3 }] }));
      m.finalizarEntrega.mockRejectedValueOnce(new SourceError('UNAVAILABLE', 'falhou'));
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO });
      const e = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO).catch((x: Error) => x);
      expect(e).toBeInstanceOf(SourceError);
      expect(e).not.toBeInstanceOf(EntregaParcialError);
    });

    it('(b) tarefa sem botão: gravou mas a leitura do estado falhou: não diz falha nem entregue, manda conferir no AVA', async () => {
      const m = montar(req({ exigeBotaoEnviar: false }));
      m.salvarEntrega.mockResolvedValueOnce({});
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const feita = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO);
      expect(feita.estado).toBe('desconhecido');
      expect(feita).not.toHaveProperty('entregue');
      expect((feita as { aviso: string }).aviso).toMatch(/gravad/);
      expect((feita as { aviso: string }).aviso).toMatch(/confira/i);
      expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
      expect(m.finalizarEntrega).not.toHaveBeenCalled();
    });

    it('enviou para avaliação mas a leitura depois falhou: estado desconhecido com aviso', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      m.finalizarEntrega.mockResolvedValueOnce({});
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const feita = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO);
      expect(feita.estado).toBe('desconhecido');
      expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
      expect(m.finalizarEntrega).toHaveBeenCalledTimes(1);
    });
  });

  describe('motivoLeitura: o código do porquê a leitura do estado falhou', () => {
    it('tarefa sem botão: o motivo da leitura do salvar chega na resposta desconhecido, com o aviso de sempre', async () => {
      const m = montar(req({ exigeBotaoEnviar: false }));
      m.salvarEntrega.mockResolvedValueOnce({ motivoLeitura: 'HTTP_504' });
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const feita = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO);
      expect(feita).toEqual({ estado: 'desconhecido', aviso: expect.stringMatching(/confira/i), motivoLeitura: 'HTTP_504' });
    });

    it('com botão: o motivo é o da leitura depois do envio (a do salvar é descartada se o envio leu o estado)', async () => {
      const m = montar(req({ exigeBotaoEnviar: true }));
      m.finalizarEntrega.mockResolvedValueOnce({ motivoLeitura: 'RESPOSTA_INVALIDA' });
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const feita = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO);
      expect(feita).toMatchObject({ estado: 'desconhecido', motivoLeitura: 'RESPOSTA_INVALIDA' });

      const n = montar(req({ exigeBotaoEnviar: true }));
      n.salvarEntrega.mockResolvedValueOnce({ motivoLeitura: 'REDE' });
      const r2 = await n.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const ok = await n.svc.confirmar(EU, 'enviar', r2.confirmacaoId, PEDIDO);
      expect(ok).toEqual({ estado: 'entregue', entregue: true });
    });

    it('estado ausente sem motivo (fonte antiga): sem motivoLeitura na resposta', async () => {
      const m = montar(req({ exigeBotaoEnviar: false }));
      m.salvarEntrega.mockResolvedValueOnce({});
      const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
      const feita = await m.svc.confirmar(EU, 'enviar', r.confirmacaoId, PEDIDO);
      expect(feita).not.toHaveProperty('motivoLeitura');
    });
  });

  describe('I7: filetypeslist com grupos, MIME ou *', () => {
    it.each<[string[]]>([[['document']], [['.pdf', 'image']], [['*']], [['application/pdf']]])(
      'lista %j não é conferida aqui: um .pdf passa (o Moodle julga)',
      async (extensoes) => {
        const m = montar(req({ extensoes }));
        await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] })).resolves.toMatchObject({ acao: 'enviar' });
        const { uploadId } = await m.svc.preparar(EU, PEDIDO);
        await expect(m.svc.receberUpload(uploadId!, [arq('LEIAME')])).resolves.toBeDefined();
      },
    );
  });

  it('I8: enviar só finalizando mostra os arquivos atuais e se há texto online', async () => {
    const atuais = [{ nome: 'a.pdf', tamanhoBytes: 3 }, { nome: 'b.zip', tamanhoBytes: 7 }];
    const m = montar(req({ exigeBotaoEnviar: true, estado: 'rascunho', arquivosAtuais: atuais, temTextoAtual: false }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO });
    expect(r.arquivosAtuais).toEqual(atuais);
    expect(r.temTextoAtual).toBe(false);
    const t = montar(req({ ...SO_TEXTO, exigeBotaoEnviar: true, estado: 'rascunho', temTextoAtual: true }));
    const rt = await t.svc.solicitar(EU, 'enviar', { ...PEDIDO });
    expect(rt.arquivosAtuais).toEqual([]);
    expect(rt.temTextoAtual).toBe(true);
    const novo = await montar(req({ exigeBotaoEnviar: true })).svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf')] });
    expect(novo.arquivosAtuais).toBeUndefined();
  });

  it('mensagem do teto de base64 é honesta: teto do serviço e ~64 KB pelo MCP', async () => {
    const m = montar(req({ maxBytesPorArquivo: undefined, maxArquivos: undefined }));
    const e = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [grande('a.pdf', MAX_BYTES_INLINE + 1)] }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(EntregaInvalidaError);
    expect((e as Error).message).toMatch(/64 KB/);
    expect((e as Error).message).toMatch(/link de upload/);
  });

  it('extensão conferida no nome que o Moodle recebe (nomeSeguro)', async () => {
    const m = montar();
    await expect(m.svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('trabalho.pdf ')] })).resolves.toMatchObject({ acao: 'enviar' });
    await expect(montar().svc.solicitar(EU, 'enviar', { ...PEDIDO, arquivos: [arq('a.pdf/')] })).rejects.toBeInstanceOf(EntregaInvalidaError);
  });
});
