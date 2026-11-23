import { DownloadLinks } from '../../application/live/download-links';
import type { ConsultaService } from '../../application/live/consulta.service';
import { McpUseCasesImpl, WEB_USOS } from './mcp-use-cases';

function build(driveInfo: (ref: string) => unknown = () => null) {
  const links = new DownloadLinks();
  const consulta = { conta: async () => ({ accountKey: 'ava:aluno' }), driveInfo: async (_q: unknown, _c: unknown, ref: string) => driveInfo(ref) } as unknown as ConsultaService;
  return { uc: new McpUseCasesImpl(consulta, links, {} as never), links };
}
const base = { userId: 'u1', baseUrl: 'https://api.ufba.app' };

describe('baixar_anexo: terminal x chat web', () => {
  it('terminal/editor/desconhecido: link de uso único e comando curl, como antes', async () => {
    for (const clientName of ['claude-code', undefined]) {
      const { uc, links } = build();
      const r = (await uc.baixarAnexo({ ...base, ...(clientName ? { clientName } : {}) }, { fonte: 'moodle', ref: 'https://ava.test/a.pdf', nome: 'Aula 1.pdf' })) as any;
      expect(r.usoUnico).toBe(true);
      expect(r.comoBaixar).toContain('curl -fL -o "Aula 1.pdf"');
      expect(r.comoLer).toBeUndefined();
      expect(r.link).toMatch(/^https:\/\/api\.ufba\.app\/download\/[\w-]+$/);
      const id = r.link.split('/').pop();
      expect(links.espiar(id)).toMatchObject({ usosRestantes: 1 });
    }
  });

  it.each(['claude-ai', 'Claude Desktop', 'chatgpt'])('chat web (%s): link para a ferramenta de URL ler, com nome na URL, poucos usos e SEM curl', async (clientName) => {
    const { uc, links } = build();
    const r = (await uc.baixarAnexo({ ...base, clientName }, { fonte: 'moodle', ref: 'https://ava.test/a.pdf', nome: 'Aula 1.pdf' })) as any;
    expect(r.comoBaixar).toBeUndefined();
    expect(r.usoUnico).toBeUndefined();
    expect(r.usos).toBe(WEB_USOS);
    expect(r.comoLer).toMatch(/ferramenta de leitura de URL/);
    expect(r.comoLer).toMatch(/10 minutos/);
    expect(r.link).toMatch(/^https:\/\/api\.ufba\.app\/download\/[\w-]+\/Aula%201\.pdf$/);
    const id = r.link.split('/')[4];
    expect(links.espiar(id)).toMatchObject({ usosRestantes: WEB_USOS, inline: true, provider: 'MOODLE', conta: 'ava:aluno' });
  });

  it('chat web com vários anexos: um link por arquivo; nome hostil não vira caminho', async () => {
    const { uc } = build();
    const r = (await uc.baixarAnexo({ ...base, clientName: 'claude-ai' }, { fonte: 'moodle', anexos: [{ ref: 'a', nome: '../../etc/passwd' }, { ref: 'b' }] })) as any;
    expect(r.arquivos).toHaveLength(2);
    expect(r.arquivos[0].link).not.toContain('..');
    expect(r.arquivos[0].link.split('/').length).toBe(6); // https: '' host download id nome
    expect(r.arquivos[1].link).toMatch(/\/download\/[\w-]+$/); // sem nome: só o id
    expect(r.comoLer).toBeDefined();
  });
});

describe('baixar_anexo: vídeo e arquivo grande do Drive não geram link', () => {
  const video = { name: 'Aula 01.mp4', mimeType: 'video/mp4', sizeBytes: 350 * 1024 * 1024, viewUrl: 'https://drive.google.com/file/d/ABCDEFGHIJK/view', blocked: 'video', message: '"Aula 01.mp4" é um vídeo (350 MB): abra no navegador: https://drive.google.com/file/d/ABCDEFGHIJK/view' };
  const ok = { name: 'slides.pdf', mimeType: 'application/pdf', sizeBytes: 1000, viewUrl: 'https://drive.google.com/file/d/ZZZZZZZZZZZ/view', blocked: null, message: null };

  it('um anexo bloqueado: aviso claro e o link para a pessoa abrir, SEM ticket de download', async () => {
    const { uc, links } = build(() => video);
    const r = (await uc.baixarAnexo(base, { fonte: 'moodle', ref: 'gdrive1.file.x.y', nome: 'Aula 01.mp4' })) as any;
    expect(r.aviso).toMatch(/vídeo \(350 MB\)/);
    expect(r.abrirNoNavegador).toBe(video.viewUrl);
    expect(r.link).toBeUndefined();
    expect(r.comoBaixar).toBeUndefined();
    expect(links.espiar('qualquer')).toBeUndefined();
  });

  it('vários: só os bloqueados viram aviso; os baixáveis seguem com link (em terminal e em chat web)', async () => {
    for (const clientName of ['claude-code', 'claude-ai']) {
      const { uc } = build((ref) => (ref === 'gdrive1.file.v.y' ? video : ref === 'gdrive1.file.ok.y' ? ok : null));
      const r = (await uc.baixarAnexo({ ...base, clientName }, { fonte: 'moodle', anexos: [{ ref: 'gdrive1.file.v.y', nome: 'Aula 01.mp4' }, { ref: 'gdrive1.file.ok.y', nome: 'slides.pdf' }, { ref: 'https://ava.test/a.pdf', nome: 'outro.pdf' }] })) as any;
      expect(r.arquivos).toHaveLength(3);
      expect(r.arquivos[0]).toMatchObject({ nome: 'Aula 01.mp4', abrirNoNavegador: video.viewUrl });
      expect(r.arquivos[0].link).toBeUndefined();
      expect(r.arquivos[1].link).toMatch(/\/download\//);
      expect(r.arquivos[2].link).toMatch(/\/download\//); // não é do Drive: nada a conferir
    }
  });

  it('sem como saber (null) ou fonte que não é o Moodle: gera o link normal', async () => {
    const { uc } = build(() => null);
    expect(((await uc.baixarAnexo(base, { fonte: 'moodle', ref: 'gdrive1.file.x.y' })) as any).link).toMatch(/\/download\//);
    const { uc: uc2 } = build(() => video);
    expect(((await uc2.baixarAnexo(base, { fonte: 'classroom', ref: 'curso:t:post:arq' })) as any).link).toMatch(/\/download\//);
  });
});

describe('entrega de tarefa: adaptador fino sobre o EntregaService', () => {
  const requisitos = {
    tarefaId: '20', titulo: 'ED2', aceitaArquivo: true, aceitaTexto: false, maxArquivos: 1, maxBytesPorArquivo: 1048576,
    extensoes: ['.pdf'], prazo: new Date('2026-11-30T23:59:00Z'), exigeBotaoEnviar: false, emGrupo: false, exigeDeclaracao: false,
    estado: 'nova', podeEditar: true, arquivosAtuais: [],
  };
  function entrega() {
    return {
      preparar: jest.fn(async () => ({
        requisitos,
        podeEntregar: true,
        atrasada: false,
        fechada: false,
        limitesArquivos: { maxArquivos: 1, maxBytesPorArquivo: 1048576, maxBytesTotal: 52428800, extensoes: ['.pdf'] },
        uploadId: 'up-123',
        expiraEm: new Date('2026-11-22T12:15:00Z'),
      })),
      solicitar: jest.fn(async () => ({ confirmacaoId: 'c1', expiraEm: new Date(), acao: 'enviar', tarefa: 'ED2', arquivos: [], efeito: 'x', atrasada: false, substituiEntrega: false })),
      confirmar: jest.fn(async (): Promise<Record<string, unknown>> => ({ estado: 'entregue', entregue: true })),
    };
  }
  const montar = (e = entrega()) => ({ uc: new McpUseCasesImpl({} as never, new DownloadLinks(), e as never), e });

  it('base64 é decodificado e vira bytes', async () => {
    const { uc, e } = montar();
    await uc.enviarTarefa(base, { cursoId: '10', tarefaId: '20', arquivos: [{ nome: 'a.pdf', conteudoBase64: Buffer.from('olá').toString('base64') }] });
    const pedido = (e.solicitar.mock.calls[0] as unknown[])[2] as { arquivos: { nome: string; bytes: Uint8Array }[] };
    expect(pedido.arquivos[0].nome).toBe('a.pdf');
    expect(pedido.arquivos[0].bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(pedido.arquivos[0].bytes).toString()).toBe('olá');
  });

  it('base64 inválido é recusado', async () => {
    const { uc, e } = montar();
    for (const conteudoBase64 of ['não é base64!', 'QUJD=', '']) {
      await expect(uc.salvarRascunhoTarefa(base, { cursoId: '10', tarefaId: '20', arquivos: [{ nome: 'a.pdf', conteudoBase64 }] })).rejects.toThrow(/base64 inválido/);
    }
    expect(e.solicitar).not.toHaveBeenCalled();
  });

  it('linkUpload usa baseUrl do principal', async () => {
    const { uc } = montar();
    const r = (await uc.prepararEnvioTarefa(base, { cursoId: '10', tarefaId: '20' })) as any;
    expect(r.linkUpload).toBe('https://api.ufba.app/upload/up-123');
    expect(r.comoEnviar).toContain('curl -fS -F "file=@');
    expect(r.comoEnviar).toContain('"https://api.ufba.app/upload/up-123"');
    expect(r.salvarJaEntrega).toBe(true);
    expect(r.estado).toBe('nova');
  });

  it('tarefa só de texto: sem link nem comoEnviar', async () => {
    const e = entrega();
    e.preparar.mockResolvedValueOnce({ requisitos: { ...requisitos, aceitaArquivo: false, aceitaTexto: true }, podeEntregar: true, atrasada: false, fechada: false } as never);
    const r = (await montar(e).uc.prepararEnvioTarefa(base, { cursoId: '10', tarefaId: '20' })) as any;
    expect(r.linkUpload).toBeUndefined();
    expect(r.comoEnviar).toBeUndefined();
  });

  it('sem confirmacaoId: resumo com confirmacaoPendente; com confirmacaoId: confirma e diz se entregou', async () => {
    const { uc, e } = montar();
    const r1 = (await uc.enviarTarefa(base, { cursoId: '10', tarefaId: '20', uploadId: 'up-123' })) as any;
    expect(e.solicitar).toHaveBeenCalledWith({ userId: 'u1' }, 'enviar', { cursoId: '10', tarefaId: '20', uploadId: 'up-123' });
    expect(r1).toMatchObject({ confirmacaoPendente: true, confirmacaoId: 'c1', tarefa: 'ED2' });
    expect(r1.instrucao).toMatch(/sim/);
    const r2 = (await uc.enviarTarefa(base, { cursoId: '10', tarefaId: '20', confirmacaoId: 'c1' })) as any;
    expect(e.confirmar).toHaveBeenCalledWith({ userId: 'u1' }, 'enviar', 'c1', { cursoId: '10', tarefaId: '20' });
    expect(r2).toMatchObject({ enviado: true, estado: 'entregue' });
    const r3 = (await uc.salvarRascunhoTarefa(base, { cursoId: '10', tarefaId: '20', confirmacaoId: 'c9' })) as any;
    expect(e.confirmar).toHaveBeenLastCalledWith({ userId: 'u1' }, 'rascunho', 'c9', { cursoId: '10', tarefaId: '20' });
    expect(r3).toMatchObject({ salvo: true });
  });

  it('a confirmação leva conta, cursoId e tarefaId ao serviço (I4)', async () => {
    const { uc, e } = montar();
    await uc.enviarTarefa(base, { conta: 'x@ufba.br', cursoId: '10', tarefaId: '20', confirmacaoId: 'c1' });
    expect(e.confirmar).toHaveBeenCalledWith({ userId: 'u1' }, 'enviar', 'c1', { conta: 'x@ufba.br', cursoId: '10', tarefaId: '20' });
  });

  it('estado desconhecido depois de gravar: gravado=true com o aviso, sem dizer enviado nem falha (I6b)', async () => {
    const e = entrega();
    e.confirmar.mockResolvedValueOnce({ estado: 'desconhecido', aviso: 'A entrega foi gravada no AVA, mas... confira o estado no AVA.' });
    const r = (await montar(e).uc.enviarTarefa(base, { cursoId: '10', tarefaId: '20', confirmacaoId: 'c1' })) as any;
    expect(r).toEqual({ gravado: true, estado: 'desconhecido', aviso: expect.stringMatching(/confira/) });
  });

  it('preparar repassa podeEntregar, motivo, atrasada, fechada e limitesArquivos do serviço; sem link quando não pode', async () => {
    const e = entrega();
    e.preparar.mockResolvedValueOnce({
      requisitos: { ...requisitos, aceitaTexto: true },
      podeEntregar: false,
      motivo: 'O envio dessa tarefa (aceita arquivo e texto) ainda não é suportado: precisa ser entregue direto pelo AVA.',
      atrasada: true,
      fechada: false,
      limitesArquivos: { maxArquivos: 1, maxBytesPorArquivo: 10, maxBytesTotal: 52428800, extensoes: [] },
    } as never);
    const r = (await montar(e).uc.prepararEnvioTarefa(base, { cursoId: '10', tarefaId: '20' })) as any;
    expect(r.podeEntregar).toBe(false);
    expect(r.motivo).toMatch(/aceita arquivo e texto/);
    // O serviço decide (o prazo do fixture está no futuro: não é recalculado aqui).
    expect(r.atrasada).toBe(true);
    expect(r.fechada).toBe(false);
    expect(r.limitesArquivos).toEqual({ maxArquivos: 1, maxBytesPorArquivo: 10, maxBytesTotal: 52428800, extensoes: 'qualquer' });
    expect(r.linkUpload).toBeUndefined();
    expect(r.uploadId).toBeUndefined();
    expect(r.comoEnviar).toBeUndefined();
  });

  it('preparar com podeEntregar: limitesArquivos do serviço e link', async () => {
    const r = (await montar().uc.prepararEnvioTarefa(base, { cursoId: '10', tarefaId: '20' })) as any;
    expect(r.podeEntregar).toBe(true);
    expect(r.motivo).toBeUndefined();
    expect(r.limitesArquivos).toEqual({ maxArquivos: 1, maxBytesPorArquivo: 1048576, maxBytesTotal: 52428800, extensoes: ['.pdf'] });
  });
});

describe('confirmação não aceita conteúdo junto', () => {
  it.each([
    { texto: 'troquei' },
    { uploadId: 'up-9' },
    { arquivos: [{ nome: 'b.pdf', conteudoBase64: 'QQ==' }] },
  ])('com confirmacaoId e %j: recusa antes de chamar o serviço', async (extra) => {
    const e = { confirmar: jest.fn(), solicitar: jest.fn() };
    const uc = new McpUseCasesImpl({} as never, new DownloadLinks(), e as never);
    for (const chamar of [uc.enviarTarefa.bind(uc), uc.salvarRascunhoTarefa.bind(uc)]) {
      await expect(chamar(base, { cursoId: '10', tarefaId: '20', confirmacaoId: 'c1', ...extra })).rejects.toThrow(/novo resumo sem `confirmacaoId`/);
    }
    expect(e.confirmar).not.toHaveBeenCalled();
    expect(e.solicitar).not.toHaveBeenCalled();
  });
});
