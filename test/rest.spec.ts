import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IdentityService } from '../src/application/identity/identity.service';
import { AUTHENTICATORS } from '../src/application/ports/authenticator';
import {
  ApiKeyRepository,
  ReadRepository,
  SourceAccountRecord,
  SourceAccountRepository,
  SyncRepository,
  UserRepository,
} from '../src/application/ports/repositories';
import { SecretCipher } from '../src/application/ports/secret-cipher';
import {
  SourceError,
  SourceGateway,
  SourceRegistry,
} from '../src/application/ports/source-gateway';
import { LeituraService } from '../src/application/read/leitura.service';
import { SincronizarService } from '../src/application/sync/sincronizar.service';
import { BearerGuard } from '../src/interface/rest/auth.guard';
import { LeituraController } from '../src/interface/rest/leitura.controller';
import { SincronizarController } from '../src/interface/rest/sincronizar.controller';
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
  const synced = new Date('2026-10-30T12:00:00Z');
  const keys = new Map<string, string>();
  const accounts: SourceAccountRecord[] = [];
  const gateway: SourceGateway = {
    provider: 'SIGAA',
    auth: 'segredo-por-requisicao',
    fetch: async (ctx) => {
      if (ctx.credentials.kind === 'password' && ctx.credentials.password === 'ruim') {
        throw new SourceError('CREDENTIAL_REJECTED', 'login recusado');
      }
      return { courseSpaces: [{ externalId: 'c1', name: 'Cálculo' }] };
    },
  };

  beforeAll(async () => {
    const registry = new SourceRegistry();
    registry.register(gateway);
    const mod = await Test.createTestingModule({
      controllers: [UsuariosController, SincronizarController, LeituraController],
      providers: [
        IdentityService,
        SincronizarService,
        LeituraService,
        BearerGuard,
        { provide: SecretCipher, useClass: FakeCipher },
        { provide: SourceRegistry, useValue: registry },
        {
          provide: AUTHENTICATORS,
          useFactory: (i: IdentityService) => [i],
          inject: [IdentityService],
        },
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
            findActiveByHash: async (h: string) =>
              keys.has(h) ? { id: 'k', userId: keys.get(h) } : null,
            touch: async () => undefined,
          },
        },
        {
          provide: SourceAccountRepository,
          useValue: {
            upsert: async (i: { userId: string; provider: 'SIGAA'; accountKey: string }) => {
              const rec = {
                id: 'a1',
                siteUrl: null,
                status: 'OK',
                lastSyncedAt: synced,
                secret: null,
                ...i,
              } as SourceAccountRecord;
              accounts.splice(0, accounts.length, rec);
              return rec;
            },
            findByUserAndProvider: async () => accounts,
            listByUser: async () => accounts,
            setStatus: async () => undefined,
            markSynced: async () => undefined,
            saveProfile: async () => undefined,
          },
        },
        {
          provide: SyncRepository,
          useValue: {
            startRun: async () => ({ id: 'r1', startedAt: new Date() }),
            finishRun: async () => undefined,
            storedHashes: async () => [],
            apply: async () => undefined,
          },
        },
        {
          provide: ReadRepository,
          useValue: {
            listCourseSpaces: async () => [],
            listItems: async () => [],
            listEvents: async () => [],
            listChanges: async () => [],
            getProfile: async () => ({
              name: null,
              registration: null,
              programName: null,
              entryTerm: null,
              accounts: [],
            }),
            getTranscript: async () => null,
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('POST /usuarios mostra a chave uma vez e ela autentica', async () => {
    const created = await request(app.getHttpServer()).post('/usuarios').send({ nome: 'Ana' });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^plt_/);
    const key = created.body.apiKey as string;

    await request(app.getHttpServer()).get('/perfil').expect(401);
    await request(app.getHttpServer()).get('/perfil').set('Authorization', 'Bearer nope').expect(401);
    const perfil = await request(app.getHttpServer())
      .get('/perfil')
      .set('Authorization', `Bearer ${key}`)
      .expect(200);
    expect(perfil.body).toHaveProperty('atualizadoEm');
  });

  it('todas as leituras devolvem atualizadoEm', async () => {
    const { body } = await request(app.getHttpServer()).post('/usuarios').send({});
    const auth = { Authorization: `Bearer ${body.apiKey}` };
    for (const path of ['/cursos', '/itens', '/agenda', '/mudancas?desde=2026-10-01T00:00:00Z', '/perfil', '/historico']) {
      const r = await request(app.getHttpServer()).get(path).set(auth).expect(200);
      expect(r.body).toHaveProperty('atualizadoEm');
      expect(r.body).toHaveProperty('dados');
    }
    await request(app.getHttpServer()).get('/mudancas').set(auth).expect(400);
  });

  it('POST /sincronizar: sucesso, credencial recusada e fonte ausente', async () => {
    const { body } = await request(app.getHttpServer()).post('/usuarios').send({});
    const auth = { Authorization: `Bearer ${body.apiKey}` };
    const ok = await request(app.getHttpServer())
      .post('/sincronizar')
      .set(auth)
      .send({ fonte: 'sigaa', usuario: 'aluno', senha: 'boa' })
      .expect(201);
    expect(ok.body.counts.created).toBe(1);
    expect(ok.body).toHaveProperty('atualizadoEm');
    expect(JSON.stringify(ok.body)).not.toContain('boa');

    const bad = await request(app.getHttpServer())
      .post('/sincronizar')
      .set(auth)
      .send({ fonte: 'sigaa', usuario: 'aluno', senha: 'ruim' })
      .expect(422);
    expect(bad.body.erro).toBe('CREDENTIAL_REJECTED');
    expect(JSON.stringify(bad.body)).not.toContain('ruim');

    await request(app.getHttpServer()).post('/sincronizar').set(auth).send({ fonte: 'moodle' }).expect(501);
    await request(app.getHttpServer()).post('/sincronizar').set(auth).send({ fonte: 'xyz' }).expect(400);
    await request(app.getHttpServer()).post('/sincronizar').set(auth).send({ fonte: 'sigaa' }).expect(400);
    await request(app.getHttpServer()).get('/fontes').set(auth).expect(200);
  });
});
