import type { INestApplication } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EntregaInvalidaError, FonteNaoConectadaError } from '../../application/live/consulta.service';
import { EntregaService, LinkUploadInvalidoError } from '../../application/live/entrega.service';
import { SourceError } from '../../application/ports/source-gateway';
import { UploadController } from './upload.controller';

describe('UploadController (POST /upload/:id)', () => {
  let app: INestApplication;
  const receberUpload = jest.fn();
  const espiarUpload = jest.fn();
  const reservarUpload = jest.fn();
  const liberarUpload = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [{ provide: EntregaService, useValue: { receberUpload, espiarUpload, reservarUpload, liberarUpload } }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    receberUpload.mockReset();
    espiarUpload.mockReset();
    espiarUpload.mockReturnValue({});
    reservarUpload.mockReset();
    reservarUpload.mockReturnValue(true);
    liberarUpload.mockReset();
  });

  /** POST cru, sem Content-Length (Transfer-Encoding: chunked), com um corpo multipart montado à mão. */
  async function postChunked(path: string, partes: { nome?: string; campo: string; conteudo: Buffer | string }[], abortarNoMeio = false) {
    const server = app.getHttpServer() as http.Server;
    if (!server.address()) await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    const b = 'XyZfronteira';
    const corpo = Buffer.concat([
      ...partes.map((p) =>
        Buffer.concat([
          Buffer.from(
            `--${b}\r\nContent-Disposition: form-data; name="${p.campo}"${p.nome !== undefined ? `; filename="${p.nome}"` : ''}\r\n` +
              (p.nome !== undefined ? 'Content-Type: application/octet-stream\r\n' : '') +
              '\r\n',
          ),
          Buffer.isBuffer(p.conteudo) ? p.conteudo : Buffer.from(p.conteudo),
          Buffer.from('\r\n'),
        ]),
      ),
      Buffer.from(`--${b}--\r\n`),
    ]);
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const r = http.request(
        { port, path, method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${b}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          let txt = '';
          res.on('data', (c) => (txt += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: txt, headers: res.headers }));
        },
      );
      r.on('error', (e) => (abortarNoMeio ? resolve({ status: 0, body: '', headers: {} }) : reject(e)));
      if (abortarNoMeio) {
        r.write(corpo.subarray(0, Math.floor(corpo.length / 2)));
        setTimeout(() => r.destroy(), 50);
        return;
      }
      for (let i = 0; i < corpo.length; i += 512) r.write(corpo.subarray(i, i + 512));
      r.end();
    });
  }

  const esperar = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('POST com um arquivo chama receberUpload(id, [{nome, bytes}]) e devolve a lista', async () => {
    receberUpload.mockResolvedValue({ arquivos: [{ nome: 'a.txt', tamanhoBytes: 5 }] });
    const res = await request(app.getHttpServer()).post('/upload/abc123').attach('file', Buffer.from('ola!!'), 'a.txt');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ arquivos: [{ nome: 'a.txt', tamanhoBytes: 5 }] });
    const [id, arquivos] = receberUpload.mock.calls[0];
    expect(id).toBe('abc123');
    expect(arquivos).toHaveLength(1);
    expect(arquivos[0].nome).toBe('a.txt');
    expect(Buffer.from(arquivos[0].bytes).toString()).toBe('ola!!');
  });

  it('link inválido: 404 LINK_INVALIDO', async () => {
    receberUpload.mockRejectedValue(new LinkUploadInvalidoError('x'));
    const res = await request(app.getHttpServer()).post('/upload/zzz').attach('file', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(404);
    expect(res.body.erro).toBe('LINK_INVALIDO');
    expect(typeof res.body.mensagem).toBe('string');
  });

  it('sem arquivo: 400 sem consumir o link', async () => {
    const res = await request(app.getHttpServer()).post('/upload/abc123').field('x', 'y');
    expect(res.status).toBe(400);
    expect(receberUpload).not.toHaveBeenCalled();
  });

  it('EntregaInvalidaError: 400; SourceError: 502; fonte não conectada: 409', async () => {
    const post = () => request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'a.txt');
    receberUpload.mockRejectedValueOnce(new EntregaInvalidaError('arquivo demais'));
    expect((await post()).status).toBe(400);
    receberUpload.mockRejectedValueOnce(new SourceError('UNAVAILABLE', 'falhou'));
    expect((await post()).status).toBe(502);
    receberUpload.mockRejectedValueOnce(new SourceError('REAUTH_NEEDED', 'reconecte'));
    expect((await post()).status).toBe(409);
    receberUpload.mockRejectedValueOnce(new FonteNaoConectadaError('nao conectado'));
    expect((await post()).status).toBe(409);
  });

  it('a resposta tem Cache-Control: no-store e Referrer-Policy: no-referrer', async () => {
    receberUpload.mockResolvedValue({ arquivos: [] });
    const ok = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'a.txt');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(ok.headers['x-robots-tag']).toContain('noindex');
    const vazio = await request(app.getHttpServer()).post('/upload/i');
    expect(vazio.headers['cache-control']).toBe('no-store');
  });

  it('não ecoa o conteúdo do arquivo nem o id em erro', async () => {
    receberUpload.mockRejectedValue(new Error('boom SEGREDO-NO-ARQUIVO meu-id-secreto'));
    const res = await request(app.getHttpServer()).post('/upload/meu-id-secreto').attach('file', Buffer.from('SEGREDO-NO-ARQUIVO'), 'SEGREDO-NO-ARQUIVO.txt');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('SEGREDO-NO-ARQUIVO');
    expect(res.text).not.toContain('meu-id-secreto');
  });

  const seguros = (h: Record<string, string>) => {
    expect(h['cache-control']).toBe('no-store');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-robots-tag']).toContain('noindex');
  };

  it('link desconhecido é recusado antes de ler o corpo: 404 com cabeçalhos e sem chamar o serviço', async () => {
    espiarUpload.mockReturnValue(undefined);
    const res = await request(app.getHttpServer()).post('/upload/desconhecido').attach('file', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(404);
    expect(res.body.erro).toBe('LINK_INVALIDO');
    seguros(res.headers);
    expect(receberUpload).not.toHaveBeenCalled();
  });

  it('arquivo acima do limite do ticket: 413 com cabeçalhos e {erro, mensagem}', async () => {
    espiarUpload.mockReturnValue({ maxBytesPorArquivo: 10 });
    const res = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.alloc(100, 'a'), 'SEGREDO.txt');
    expect(res.status).toBe(413);
    expect(res.body.erro).toBe('ARQUIVO_GRANDE_DEMAIS');
    expect(typeof res.body.mensagem).toBe('string');
    expect(res.text).not.toContain('SEGREDO');
    seguros(res.headers);
    expect(receberUpload).not.toHaveBeenCalled();
  });

  it('Content-Length acima do máximo do ticket: 413 cedo', async () => {
    espiarUpload.mockReturnValue({ maxBytesPorArquivo: 10, maxArquivos: 1 });
    const res = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.alloc(200 * 1024, 'a'), 'a.bin');
    expect(res.status).toBe(413);
    seguros(res.headers);
    expect(receberUpload).not.toHaveBeenCalled();
  });

  it('mais arquivos que o permitido: 400 com cabeçalhos e {erro, mensagem}', async () => {
    espiarUpload.mockReturnValue({ maxArquivos: 1 });
    const res = await request(app.getHttpServer())
      .post('/upload/i')
      .attach('file', Buffer.from('a'), 'a.txt')
      .attach('file', Buffer.from('b'), 'b.txt');
    expect(res.status).toBe(400);
    expect(res.body.erro).toBe('ENVIO_INVALIDO');
    expect(typeof res.body.mensagem).toBe('string');
    seguros(res.headers);
    expect(receberUpload).not.toHaveBeenCalled();
  });

  describe('I1: memória do upload', () => {
    it('o Buffer do multer vai direto ao serviço (sem cópia)', async () => {
      receberUpload.mockResolvedValue({ arquivos: [] });
      await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('ola'), 'a.txt');
      expect(Buffer.isBuffer(receberUpload.mock.calls[0][1][0].bytes)).toBe(true);
    });

    it('reserva o link antes de ler o corpo; outro envio no mesmo link: 429 ENVIO_OCUPADO sem ler nem chamar o serviço', async () => {
      reservarUpload.mockReturnValue(false);
      const res = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'a.txt');
      expect(res.status).toBe(429);
      expect(res.body.erro).toBe('ENVIO_OCUPADO');
      expect(typeof res.body.mensagem).toBe('string');
      seguros(res.headers);
      expect(receberUpload).not.toHaveBeenCalled();
      expect(reservarUpload).toHaveBeenCalledWith('i');
    });

    it('corpo inválido ou sem arquivo libera a reserva', async () => {
      espiarUpload.mockReturnValue({ maxArquivos: 1 });
      await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('a'), 'a.txt').attach('file', Buffer.from('b'), 'b.txt');
      expect(liberarUpload).toHaveBeenCalledWith('i');
      liberarUpload.mockReset();
      await request(app.getHttpServer()).post('/upload/j').field('x', 'y');
      expect(liberarUpload).toHaveBeenCalledWith('j');
      expect(receberUpload).not.toHaveBeenCalled();
    });

    it('conexão caída no meio do corpo libera a reserva', async () => {
      await postChunked('/upload/caiu', [{ campo: 'file', nome: 'a.bin', conteudo: Buffer.alloc(64 * 1024, 'a') }], true);
      await esperar(() => liberarUpload.mock.calls.length > 0);
      expect(liberarUpload).toHaveBeenCalledWith('caiu');
      expect(receberUpload).not.toHaveBeenCalled();
    });

    it('Content-Length acima do teto somado do envio: 413 cedo', async () => {
      espiarUpload.mockReturnValue({ maxArquivos: 5, maxBytesPorArquivo: 10 * 1024 * 1024, maxBytesTotal: 1000 });
      const res = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.alloc(200 * 1024, 'a'), 'a.bin');
      expect(res.status).toBe(413);
      expect(res.body.erro).toBe('ARQUIVO_GRANDE_DEMAIS');
      seguros(res.headers);
      expect(receberUpload).not.toHaveBeenCalled();
    });

    it('sem Content-Length (chunked) o corpo continua limitado pelo teto somado: 413', async () => {
      // Cada arquivo cabe no limite por arquivo; a soma passa do teto somado (+ a folga de 64 KB do multipart).
      espiarUpload.mockReturnValue({ maxArquivos: 5, maxBytesPorArquivo: 60 * 1024, maxBytesTotal: 1000 });
      const res = await postChunked('/upload/i', [
        { campo: 'file', nome: 'a.bin', conteudo: Buffer.alloc(50 * 1024, 'a') },
        { campo: 'file', nome: 'b.bin', conteudo: Buffer.alloc(50 * 1024, 'b') },
      ]);
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).erro).toBe('ARQUIVO_GRANDE_DEMAIS');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(receberUpload).not.toHaveBeenCalled();
      expect(liberarUpload).toHaveBeenCalled();
    });

    it('sem Content-Length e um arquivo acima do limite por arquivo: 413', async () => {
      espiarUpload.mockReturnValue({ maxBytesPorArquivo: 100 });
      const res = await postChunked('/upload/i', [{ campo: 'file', nome: 'a.bin', conteudo: Buffer.alloc(5000, 'a') }]);
      expect(res.status).toBe(413);
      expect(receberUpload).not.toHaveBeenCalled();
    });

    it('campos demais ou campo grande demais: 400 ENVIO_INVALIDO', async () => {
      let r = request(app.getHttpServer()).post('/upload/i');
      for (let n = 0; n < 10; n++) r = r.field(`c${n}`, 'v');
      const muitos = await r.attach('file', Buffer.from('x'), 'a.txt');
      expect(muitos.status).toBe(400);
      expect(muitos.body.erro).toBe('ENVIO_INVALIDO');
      const grande = await request(app.getHttpServer()).post('/upload/i').field('c', 'v'.repeat(4096)).attach('file', Buffer.from('x'), 'a.txt');
      expect(grande.status).toBe(400);
      expect(grande.body.erro).toBe('ENVIO_INVALIDO');
      expect(receberUpload).not.toHaveBeenCalled();
    });

    it('no máximo 2 envios em andamento: o terceiro recebe 429 ENVIO_OCUPADO', async () => {
      const soltar: Array<() => void> = [];
      receberUpload.mockImplementation(() => new Promise((r) => soltar.push(() => r({ arquivos: [] }))));
      const post = (id: string) => request(app.getHttpServer()).post(`/upload/${id}`).attach('file', Buffer.from('x'), 'a.txt');
      const p1 = post('a').then((x) => x);
      const p2 = post('b').then((x) => x);
      await esperar(() => receberUpload.mock.calls.length === 2);
      const terceiro = await post('c');
      expect(terceiro.status).toBe(429);
      expect(terceiro.body.erro).toBe('ENVIO_OCUPADO');
      seguros(terceiro.headers);
      soltar.forEach((f) => f());
      expect((await p1).status).toBe(200);
      expect((await p2).status).toBe(200);
      // Terminados os dois, o contador volta: um novo envio passa.
      receberUpload.mockResolvedValue({ arquivos: [] });
      expect((await post('d')).status).toBe(200);
    });
  });

  it('I2: nome com acento chega intacto ao serviço', async () => {
    receberUpload.mockResolvedValue({ arquivos: [] });
    const res = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'relatório.pdf');
    expect(res.status).toBe(200);
    expect(receberUpload.mock.calls[0][1][0].nome).toBe('relatório.pdf');
  });

  it('409 não ecoa a mensagem da fonte (conta) para quem tem o link', async () => {
    receberUpload.mockRejectedValueOnce(new FonteNaoConectadaError('Moodle: a conta "aluno@ufba.br" não está conectada'));
    const r1 = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'a.txt');
    expect(r1.status).toBe(409);
    expect(r1.text).not.toContain('aluno@ufba.br');
    expect(typeof r1.body.mensagem).toBe('string');
    receberUpload.mockRejectedValueOnce(new SourceError('REAUTH_NEEDED', 'token de aluno@ufba.br recusado'));
    const r2 = await request(app.getHttpServer()).post('/upload/i').attach('file', Buffer.from('x'), 'a.txt');
    expect(r2.status).toBe(409);
    expect(r2.body.erro).toBe('REAUTH_NEEDED');
    expect(r2.text).not.toContain('aluno@ufba.br');
  });
});
