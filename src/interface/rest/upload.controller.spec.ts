import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EntregaInvalidaError, FonteNaoConectadaError } from '../../application/live/consulta.service';
import { EntregaService, LinkUploadInvalidoError } from '../../application/live/entrega.service';
import { SourceError } from '../../application/ports/source-gateway';
import { UploadController } from './upload.controller';

describe('UploadController (POST /upload/:id)', () => {
  let app: INestApplication;
  const receberUpload = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [{ provide: EntregaService, useValue: { receberUpload } }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => receberUpload.mockReset());

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
});
