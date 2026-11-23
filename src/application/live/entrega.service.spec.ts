import type { ArquivoParaEnvio, EntregaTarefa, LiveSource, RequisitosEntrega } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import type { Provider, SourceContext } from '../ports/source-gateway';
import { ConsultaService, EntregaInvalidaError, type Quem } from './consulta.service';
import { ConfirmacoesEntrega, UploadLinks } from './entrega-links';
import { EntregaService, MAX_BYTES_INLINE } from './entrega.service';

const EU: Quem = { userId: 'u1' };
const OUTRA: Quem = { userId: 'u2' };
const AGORA = Date.parse('2026-11-22T12:00:00Z');
const HORA = 3_600_000;

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
    tarefaId: '42',
    titulo: 'Lista 2',
    aceitaArquivo: true,
    aceitaTexto: true,
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
    ...over,
  };
}

const arq = (nome: string, tamanho = 10): ArquivoParaEnvio => ({ nome, bytes: new Uint8Array(tamanho) });

function montar(requisitos: RequisitosEntrega = req()) {
  let agora = AGORA;
  const clock = () => agora;
  const state = { requisitos };
  const requisitosEntrega = jest.fn(async (_ctx: SourceContext, _c: string, _t: string) => state.requisitos);
  const subirArquivosEntrega = jest.fn(async (_ctx: SourceContext, arquivos: ArquivoParaEnvio[]) => ({
    itemId: '777',
    arquivos: arquivos.map((a) => ({ nome: a.nome, tamanhoBytes: a.bytes.length })),
  }));
  const salvarEntrega = jest.fn(async (_ctx: SourceContext, _e: EntregaTarefa) => ({
    estado: state.requisitos.exigeBotaoEnviar ? ('rascunho' as const) : ('entregue' as const),
  }));
  const finalizarEntrega = jest.fn(async (_ctx: SourceContext, _t: string) => ({ estado: 'entregue' as const }));
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

const PEDIDO = { cursoId: '7', tarefaId: '42' };

describe('EntregaService', () => {
  it('preparar devolve os requisitos e um uploadId; sem aceitaArquivo não há uploadId', async () => {
    const m = montar();
    const p = await m.svc.preparar(EU, PEDIDO);
    expect(p.requisitos.titulo).toBe('Lista 2');
    expect(p.uploadId).toEqual(expect.any(String));
    expect(p.expiraEm).toEqual(new Date(AGORA + 15 * 60_000));
    expect(m.requisitosEntrega).toHaveBeenCalledWith(expect.objectContaining({ accountKey: 'u1@ufba.br' }), '7', '42');

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
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'minha resposta', arquivos: [arq('a.pdf', 12)] });
    expect(r.confirmacaoId).toEqual(expect.any(String));
    expect(r.expiraEm).toEqual(new Date(AGORA + 10 * 60_000));
    expect(r.acao).toBe('enviar');
    expect(r.tarefa).toBe('Lista 2');
    expect(r.arquivos).toEqual([{ nome: 'a.pdf', tamanhoBytes: 12 }]);
    expect(r.texto).toBe('minha resposta');
    expect(r.efeito).toContain('entrega');
    expect(r.prazo).toEqual(new Date(AGORA + 24 * HORA));
    expect(r.atrasada).toBe(false);
    expect(r.substituiEntrega).toBe(false);
    m.nadaEscrito();
  });

  it('com exigeBotaoEnviar=true: rascunho → efeito "salva como rascunho"; enviar → "entrega"', async () => {
    const m = montar(req({ exigeBotaoEnviar: true }));
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
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'x' });
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
    const m = montar(req({ aceitaArquivo: false }));
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
    m.state.requisitos = req({ tarefaId: '43' });
    await expect(m.svc.solicitar(EU, 'enviar', { cursoId: '7', tarefaId: '43', uploadId })).rejects.toBeInstanceOf(EntregaInvalidaError);
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
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(m.salvarEntrega).not.toHaveBeenCalled();
    expect(m.finalizarEntrega).toHaveBeenCalledWith(expect.anything(), '42');
  });

  it('confirmar enviar: salva e, com exigeBotaoEnviar=true, também finaliza; sem botão só salva (não chama finalizarEntrega)', async () => {
    const com = montar(req({ exigeBotaoEnviar: true }));
    const r1 = await com.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi', arquivos: [arq('a.pdf')] });
    await expect(com.svc.confirmar(EU, 'enviar', r1.confirmacaoId)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(com.salvarEntrega).toHaveBeenCalledWith(expect.objectContaining({ accountKey: 'u1@ufba.br' }), { tarefaId: '42', itemId: '777', texto: 'oi' });
    expect(com.finalizarEntrega).toHaveBeenCalledWith(expect.anything(), '42');

    const sem = montar(req({ exigeBotaoEnviar: false }));
    const r2 = await sem.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    await expect(sem.svc.confirmar(EU, 'enviar', r2.confirmacaoId)).resolves.toEqual({ estado: 'entregue', entregue: true });
    expect(sem.salvarEntrega).toHaveBeenCalledWith(expect.anything(), { tarefaId: '42', texto: 'oi' });
    expect(sem.finalizarEntrega).not.toHaveBeenCalled();
  });

  it('confirmar rascunho: só salva', async () => {
    const m = montar(req({ exigeBotaoEnviar: true }));
    const r = await m.svc.solicitar(EU, 'rascunho', { ...PEDIDO, texto: 'oi' });
    await expect(m.svc.confirmar(EU, 'rascunho', r.confirmacaoId)).resolves.toEqual({ estado: 'rascunho', entregue: false });
    expect(m.salvarEntrega).toHaveBeenCalledTimes(1);
    expect(m.finalizarEntrega).not.toHaveBeenCalled();
  });

  it('confirmar com id de outra pessoa, expirado, reutilizado ou de outra ação: EntregaInvalidaError e nada escrito', async () => {
    const m = montar(req({ exigeBotaoEnviar: true }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    await expect(m.svc.confirmar(OUTRA, 'enviar', r.confirmacaoId)).rejects.toBeInstanceOf(EntregaInvalidaError);
    await expect(m.svc.confirmar(EU, 'rascunho', r.confirmacaoId)).rejects.toBeInstanceOf(EntregaInvalidaError);
    await expect(m.svc.confirmar(EU, 'enviar', 'inexistente')).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.avancar(10 * 60_000 + 1);
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();

    const n = montar(req({ exigeBotaoEnviar: true }));
    const r2 = await n.svc.solicitar(EU, 'rascunho', { ...PEDIDO, texto: 'oi' });
    await n.svc.confirmar(EU, 'rascunho', r2.confirmacaoId);
    expect(n.salvarEntrega).toHaveBeenCalledTimes(1);
    await expect(n.svc.confirmar(EU, 'rascunho', r2.confirmacaoId)).rejects.toBeInstanceOf(EntregaInvalidaError);
    expect(n.salvarEntrega).toHaveBeenCalledTimes(1);
  });

  it('confirmar revalida a tarefa: se o limite passou desde o resumo, recusa e nada escrito', async () => {
    const m = montar(req({ limite: new Date(AGORA + 60_000) }));
    const r = await m.svc.solicitar(EU, 'enviar', { ...PEDIDO, texto: 'oi' });
    m.avancar(2 * 60_000);
    await expect(m.svc.confirmar(EU, 'enviar', r.confirmacaoId)).rejects.toBeInstanceOf(EntregaInvalidaError);
    m.nadaEscrito();
  });
});
