import { Secret } from '../src/application/shared/secret';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IdentityService } from '../src/application/identity/identity.service';
import { ConsultaService } from '../src/application/live/consulta.service';
import { DownloadLinks } from '../src/application/live/download-links';
import { AUTHENTICATORS } from '../src/application/ports/authenticator';
import { LiveSources, type LiveSource } from '../src/application/ports/live-source';
import {
  ApiKeyRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  UserRepository,
} from '../src/application/ports/repositories';
import { SecretCipher } from '../src/application/ports/secret-cipher';
import { CofreSigaa } from '../src/application/sigaa/cofre-sigaa';
import { SourceError, SourceGateway, SourceRegistry } from '../src/application/ports/source-gateway';
import { BearerGuard } from '../src/interface/rest/auth.guard';
import { DownloadController } from '../src/interface/rest/download.controller';
import { FontesController } from '../src/interface/rest/fontes.controller';
import { UsuariosController } from '../src/interface/rest/usuarios.controller';

class FakeCipher extends SecretCipher {
  encrypt(p: string) {
    return { ciphertext: p, iv: 'i', authTag: 't' };
  }
  decrypt(s: { ciphertext: string }) {
    return s.ciphertext;
  }
}

describe('REST (sem banco, sem rede)', () => {
  let app: INestApplication;
  let links: DownloadLinks;
  const keys = new Map<string, string>();
  const baixar = jest.fn();
  const moodle: SourceAccountRecord = {
    id: 'a1',
    userId: 'u1',
    provider: 'MOODLE',
    accountKey: 'ava.ufba.br:aluno',
    siteUrl: 'https://ava.ufba.br',
    status: 'OK',
    lastSyncedAt: null,
    expiresAt: null,
    secret: { ciphertext: 'WSTOKEN', iv: 'i', authTag: 't' },
  };

  beforeAll(async () => {
    const registry = new SourceRegistry();
    registry.register({ provider: 'SIGAA', auth: 'segredo-por-requisicao', fetch: jest.fn() } as SourceGateway);
    const live = new LiveSources();
    live.register({ provider: 'MOODLE', baixar } as unknown as LiveSource);
    const mod = await Test.createTestingModule({
      controllers: [UsuariosController, FontesController, DownloadController],
      providers: [
        IdentityService,
        BearerGuard,
        ConsultaService,
        DownloadLinks,
        { provide: CofreSigaa, useValue: { situacao: async () => null } },
        { provide: LiveSources, useValue: live },
        { provide: SecretCipher, useClass: FakeCipher },
        { provide: SourceRegistry, useValue: registry },
        { provide: AUTHENTICATORS, useFactory: (i: IdentityService) => [i], inject: [IdentityService] },
        {
          provide: UserRepository,
          useValue: { create: async () => ({ id: 'u1', name: null, createdAt: new Date() }) },
        },
        {
          provide: ApiKeyRepository,
          useValue: {
            create: async (i: { keyHash: string; userId: string }) => {
              keys.set(i.keyHash, i.userId);
              return { id: 'k', userId: i.userId };
            },
            findActiveByHash: async (h: string) => (keys.has(h) ? { id: 'k', userId: keys.get(h) } : null),
            touch: async () => undefined,
          },
        },
        {
          provide: SourceAccountRepository,
          useValue: {
            findByUserAndProvider: async (userId: string, p: string) =>
              userId === 'u1' && p === 'MOODLE' ? [moodle] : [],
            setStatus: jest.fn(),
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    links = mod.get(DownloadLinks);
  });

  afterAll(() => app.close());
  beforeEach(() => baixar.mockReset());

  it('POST /usuarios mostra a chave uma vez e ela autentica', async () => {
    const created = await request(app.getHttpServer()).post('/usuarios').send({ nome: 'Ana' });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^plt_/);
    await request(app.getHttpServer()).get('/fontes').expect(401);
    await request(app.getHttpServer()).get('/fontes').set('Authorization', 'Bearer nope').expect(401);
    const fontes = await request(app.getHttpServer())
      .get('/fontes')
      .set('Authorization', `Bearer ${created.body.apiKey}`)
      .expect(200);
    expect(fontes.body).toEqual([{ fonte: 'sigaa', autenticacao: 'segredo-por-requisicao' }]);
  });

  it('rotas de sincronização e leitura de banco não existem mais', async () => {
    const { body } = await request(app.getHttpServer()).post('/usuarios').send({});
    const auth = { Authorization: `Bearer ${body.apiKey}` };
    await request(app.getHttpServer()).post('/sincronizar').set(auth).send({ fonte: 'moodle' }).expect(404);
    for (const path of ['/cursos', '/itens', '/agenda', '/mudancas', '/perfil', '/historico']) {
      await request(app.getHttpServer()).get(path).set(auth).expect(404);
    }
  });

  it('GET /download/:id baixa da fonte na hora, uma vez só, com o token da conta', async () => {
    baixar.mockResolvedValue({ bytes: new TextEncoder().encode('%PDF'), mimeType: 'application/pdf', fileName: 'Lista 1.pdf' });
    const { id } = links.criar({ userId: 'u1', provider: 'MOODLE', conta: 'ava.ufba.br:aluno', ref: 'https://ava.ufba.br/pluginfile.php/1/a.pdf' });

    const r = await request(app.getHttpServer()).get(`/download/${id}`).expect(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''Lista%201.pdf");
    expect(baixar).toHaveBeenCalledTimes(1);
    expect(baixar.mock.calls[0][0]).toMatchObject({ credentials: { kind: 'token', token: expect.any(Secret) } });
    expect((baixar.mock.calls[0][0] as { credentials: { token: Secret } }).credentials.token.reveal()).toBe('WSTOKEN');
    expect(baixar.mock.calls[0][1]).toBe('https://ava.ufba.br/pluginfile.php/1/a.pdf');

    await request(app.getHttpServer()).get(`/download/${id}`).expect(404); // uso único
    expect(baixar).toHaveBeenCalledTimes(1);
  });

  it('link inexistente dá 404; fonte fora do ar dá 502 sem vazar o token', async () => {
    await request(app.getHttpServer()).get('/download/nao-existe').expect(404);
    baixar.mockRejectedValue(new SourceError('UNAVAILABLE', 'Moodle HTTP 504 ao baixar anexo'));
    const { id } = links.criar({ userId: 'u1', provider: 'MOODLE', conta: 'ava.ufba.br:aluno', ref: 'https://ava.ufba.br/x' });
    const r = await request(app.getHttpServer()).get(`/download/${id}`).expect(502);
    expect(JSON.stringify(r.body)).not.toContain('WSTOKEN');
  });

  it('conta sem Moodle conectado dá 409', async () => {
    const { id } = links.criar({ userId: 'outro', provider: 'MOODLE', conta: 'ava.ufba.br:aluno', ref: 'https://ava.ufba.br/x' });
    const r = await request(app.getHttpServer()).get(`/download/${id}`).expect(409);
    expect(r.body.mensagem).toContain('não conectado');
    expect(baixar).not.toHaveBeenCalled();
  });
});
