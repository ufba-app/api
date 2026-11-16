import { Secret } from '../shared/secret';
import { LiveSources } from '../ports/live-source';
import type { LiveSource } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import type { SourceHealthRepository } from '../ports/source-health';
import { SourceError, type SourceContext } from '../ports/source-gateway';
import { ConsultaService } from './consulta.service';
import { SourceHealthRecorder } from './source-health-recorder';

const TOKEN = 'CANARIO-token-moodle-7731';
const conta: SourceAccountRecord = {
  id: 'id-1',
  userId: 'u1',
  provider: 'MOODLE',
  accountKey: 'ava.ufba.br:aluna',
  siteUrl: 'https://ava.ufba.br',
  status: 'OK',
  lastSyncedAt: null,
  expiresAt: null,
  secret: { ciphertext: TOKEN, iv: '', authTag: '' },
};

function build(modo: 'ok' | 'unavailable' | 'blocked' | 'reauth' | 'noaccess') {
  const gravado: unknown[] = [];
  const repo: SourceHealthRepository = {
    list: async () => [],
    recordSuccess: async (...a) => void gravado.push(['ok', ...a]),
    recordFailure: async (...a) => void gravado.push(['fail', ...a]),
  };
  const source = {
    provider: 'MOODLE',
    listarCursos: async (ctx: SourceContext) => {
      const t = (ctx.credentials as { token: Secret }).token.reveal();
      if (modo === 'unavailable') throw new SourceError('UNAVAILABLE', `504 em ${t}`);
      if (modo === 'blocked') throw new SourceError('BLOCKED', `waf ${t}`);
      if (modo === 'reauth') throw new SourceError('REAUTH_NEEDED', `token ${t} recusado`);
      if (modo === 'noaccess') throw new SourceError('NO_ACCESS', 'sem acesso');
      return [{ id: '1', nome: 'c' }];
    },
  } as unknown as LiveSource;
  const live = new LiveSources();
  live.register(source);
  const accounts = {
    findByUserAndProvider: async () => [conta],
    listByUser: async () => [conta],
    setStatus: async () => undefined,
  } as never;
  const cipher = { decrypt: (s: { ciphertext: string }) => s.ciphertext } as never;
  const svc = new ConsultaService(live, accounts, cipher, {} as never, undefined, new SourceHealthRecorder(repo));
  return { svc, gravado };
}

describe('ConsultaService registra a saúde da conta (só metadados)', () => {
  it('leitura que deu certo grava ok', async () => {
    const { svc, gravado } = build('ok');
    await svc.listarCursos({ userId: 'u1' }, 'MOODLE');
    expect(gravado).toEqual([['ok', 'u1', 'MOODLE', 'ava.ufba.br:aluna', expect.any(Date)]]);
  });

  it.each(['unavailable', 'blocked'] as const)('%s grava source_unavailable e repassa o erro', async (modo) => {
    const { svc, gravado } = build(modo);
    await expect(svc.listarCursos({ userId: 'u1' }, 'MOODLE')).rejects.toBeInstanceOf(SourceError);
    expect(gravado).toEqual([['fail', 'u1', 'MOODLE', 'ava.ufba.br:aluna', 'source_unavailable', expect.any(Date)]]);
  });

  it('token recusado e erros que não dizem nada da fonte não gravam falha', async () => {
    for (const modo of ['reauth', 'noaccess'] as const) {
      const { svc, gravado } = build(modo);
      await svc.listarCursos({ userId: 'u1' }, 'MOODLE').catch(() => undefined);
      expect(gravado).toEqual([]);
    }
  });

  it('canário: o token que veio na mensagem do erro nunca chega ao que é gravado', async () => {
    for (const modo of ['ok', 'unavailable', 'blocked', 'reauth'] as const) {
      const { svc, gravado } = build(modo);
      await svc.listarCursos({ userId: 'u1' }, 'MOODLE').catch(() => undefined);
      expect(JSON.stringify(gravado)).not.toContain(TOKEN);
    }
  });
});
