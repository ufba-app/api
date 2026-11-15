import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SiasbCopyReader } from '../src/application/siasb/siasb-copy-reader';
import { SiasbLink } from '../src/application/siasb/siasb-link';
import type { SecretCipher } from '../src/application/ports/secret-cipher';
import { SiasbController } from '../src/interface/web/web.controllers';
import { SessionGuard } from '../src/interface/web/web-auth';
import { InMemorySiasbCopy } from './support/siasb-copy-fake';

const NOME = 'Zeferina';
const DAY = 86_400_000;

/** Cifra falsa e reversível (sem AES). */
const cipher: SecretCipher = {
  encrypt: (plain: string, aad = '') => ({
    ciphertext: Buffer.from(JSON.stringify([plain, aad])).toString('base64'),
    iv: 'iv',
    authTag: 'tag',
  }),
  decrypt: (secret: { ciphertext: string }, aad = '') => {
    const [plain, used] = JSON.parse(Buffer.from(secret.ciphertext, 'base64').toString());
    if (used !== aad) throw new Error('aad');
    return plain as string;
  },
};

describe('GET /me/siasb/sessions', () => {
  let app: INestApplication;
  let base: string;
  const copy = new InMemorySiasbCopy();
  const connected = new Set<string>(['u1']);
  let userId = 'u1';

  const at = (days: number) => new Date(Date.now() + days * DAY);
  const session = (id: string, start: Date) => ({
    id,
    attendanceId: 'a1',
    disciplineId: 'd1',
    disciplineName: 'Clinica 1',
    professorName: 'Profa. Teste',
    locationName: 'Sala 1',
    startAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    rescheduledStartAt: null,
    statusLabel: 'Agendada',
  });

  beforeAll(async () => {
    copy.accounts.set('u1', 'OK');
    await copy.replaceWindow(
      'u1',
      { from: at(-400), to: at(400) },
      {
        disciplines: [],
        attendances: [
          {
            id: 'a1',
            disciplineId: 'd1',
            disciplineName: 'Clinica 1',
            treatmentType: 'PLANNING',
            concluded: false,
            active: true,
            firstName: cipher.encrypt(NOME, 'siasb-attendance:u1:a1'),
          },
        ],
        sessions: [
          session('antiga', at(-20)),
          session('recente', at(-10)),
          session('proxima', at(30)),
          session('longe', at(60)),
        ],
      },
    );
    copy.seedState('u1');
    await copy.recordAttempt('u1', { result: 'OK', at: new Date(), nextRunAt: null });

    const link = {
      status: async (u: string) => ({ state: connected.has(u) ? 'connected' : 'disconnected' }),
    };
    const mod = await Test.createTestingModule({
      controllers: [SiasbController],
      providers: [
        { provide: SiasbLink, useValue: link },
        { provide: SiasbCopyReader, useValue: new SiasbCopyReader(copy, cipher, { holidays: async () => ({ known: false, dates: [] }) }) },
      ],
    })
      .overrideGuard(SessionGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().web = { userId, clientId: 'c' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (qs = '') => fetch(`${base}/me/siasb/sessions${qs}`);
  const iso = (d: Date) => encodeURIComponent(d.toISOString());

  it('intervalo padrão (14 dias atrás a 45 à frente), ordenado, no-store, com o primeiro nome', async () => {
    userId = 'u1';
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as any;
    expect(body.items.map((i: any) => i.id)).toEqual(['recente', 'proxima']);
    expect(body.items[0].patientFirstName).toBe(NOME);
    expect(body.items[0].rescheduledStartAt).toBeNull();
    expect(typeof body.items[0].startAt).toBe('string');
    expect(body.stale).toBe(false);
    expect(typeof body.syncedAt).toBe('string');
  });

  it('?from=&to= explícitos', async () => {
    const r = await get(`?from=${iso(at(-25))}&to=${iso(at(-15))}`);
    expect(((await r.json()) as any).items.map((i: any) => i.id)).toEqual(['antiga']);
  });

  it('from > to: 400 invalid_request, sem nome na resposta', async () => {
    const r = await get(`?from=${iso(at(10))}&to=${iso(at(-10))}`);
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(JSON.parse(text).error).toBe('invalid_request');
    expect(text).not.toContain(NOME);
  });

  it('intervalo de 190 dias passa; de 191 dias: 400', async () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const ok = await get(`?from=${iso(from)}&to=${iso(new Date(from.getTime() + 190 * DAY))}`);
    expect(ok.status).toBe(200);
    const bad = await get(`?from=${iso(from)}&to=${iso(new Date(from.getTime() + 191 * DAY))}`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe('invalid_request');
  });

  it('data pura ou data-hora sem fuso: 400 sem ecoar o valor; com Z ou -03:00: 200', async () => {
    const enc = encodeURIComponent;
    for (const bad of ['2026-11-27', '2026-11-27T10:00:00', '2026-11-27T10:00']) {
      const r = await get(`?from=${enc(bad)}`);
      expect(r.status).toBe(400);
      const text = await r.text();
      expect(JSON.parse(text).error).toBe('invalid_request');
      expect(text).not.toContain(bad);
    }
    expect((await get(`?to=${enc('2026-11-27')}`)).status).toBe(400);
    const z = await get(`?from=${enc('2026-11-20T00:00:00Z')}&to=${enc('2026-11-27T00:00:00Z')}`);
    expect(z.status).toBe(200);
    const br = await get(`?from=${enc('2026-11-20T00:00:00-03:00')}&to=${enc('2026-11-27T00:00:00-03:00')}`);
    expect(br.status).toBe(200);
  });

  it('data inválida: 400 sem ecoar o valor', async () => {
    const r = await get('?from=lixo-secreto');
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain('lixo-secreto');
    expect(text).not.toContain(NOME);
  });

  it('sem conta SIASB: 404 not_found, sem nome', async () => {
    userId = 'u2';
    const r = await get();
    expect(r.status).toBe(404);
    const text = await r.text();
    expect(JSON.parse(text).error).toBe('not_found');
    expect(text).not.toContain(NOME);
    userId = 'u1';
  });

  it('outro usuário com conta não vê a cópia do dono', async () => {
    connected.add('u3');
    userId = 'u3';
    const body = (await (await get()).json()) as any;
    expect(body.items).toEqual([]);
    expect(body.stale).toBe(true);
    expect(body.syncedAt).toBeNull();
    expect(JSON.stringify(body)).not.toContain(NOME);
    userId = 'u1';
  });
});
