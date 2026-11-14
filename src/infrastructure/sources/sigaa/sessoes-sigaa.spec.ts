import { Secret } from '../../../application/shared/secret';
import { SecretCipher } from '../../../application/ports/secret-cipher';
import type { SigaaSessionKey } from '../../../application/ports/repositories';
import { MemorySigaaSessionStore } from './memory-session-store';
import { SessoesSigaa, SigaaOcupadoError } from './sessoes-sigaa';
import {
  SigaaInvalidCredentialsError,
  SigaaSessionExpiredError,
  type SigaaSession,
} from './session';

const MIN = 60_000;
const A: SigaaSessionKey = { userId: 'u1', login: 'fulano' };
const B: SigaaSessionKey = { userId: 'u2', login: 'beltrano' };

/** Cifra falsa e reversível: o que o store guarda NÃO é o cookie em claro. */
const cipher = {
  encrypt: (s: string) => ({ ciphertext: Buffer.from(s).reverse().toString('hex'), iv: 'iv', authTag: 'tag' }),
  decrypt: (e: { ciphertext: string }) => Buffer.from(e.ciphertext, 'hex').reverse().toString(),
} as unknown as SecretCipher;

/** Sessão falsa: `login` gera um cookie novo; `resume` registra o cookie retomado. */
function montar(opts: { login?: () => Promise<void>; store?: MemorySigaaSessionStore } = {}) {
  let agora = 0;
  const now = () => agora;
  const store = opts.store ?? new MemorySigaaSessionStore(now);
  const logins: string[] = [];
  const retomados: string[] = [];
  let n = 0;
  const criar = jest.fn(() => {
    let cookie: string | undefined;
    return {
      login: jest.fn(async () => {
        await (opts.login ?? (() => Promise.resolve()))();
        cookie = `JSESSIONID=s${++n}`;
        logins.push(cookie);
      }),
      resume: jest.fn((c: Secret) => {
        cookie = c.reveal();
        retomados.push(cookie);
      }),
      exportCookie: () => (cookie ? Secret.of(cookie) : undefined),
    } as unknown as SigaaSession;
  });
  const avancar = (ms: number) => (agora += ms);
  const sleep = async (ms: number) => void avancar(ms);
  const sessoes = new SessoesSigaa(criar, store, cipher, { now, sleep });
  const obter = jest.fn(async () => ({ login: 'fulano', password: Secret.of('senha-falsa') }));
  return { sessoes, store, criar, obter, logins, retomados, avancar, now, sleep };
}

describe('SessoesSigaa', () => {
  it('a senha só é aberta quando é preciso logar: sessão guardada e viva não chama obterCred', async () => {
    const { sessoes, obter, logins, retomados } = montar();
    await sessoes.usar(A, obter, async () => 1);
    await sessoes.usar(A, obter, async () => 2);
    await sessoes.usar(A, obter, async () => 3);
    expect(obter).toHaveBeenCalledTimes(1);
    expect(logins).toEqual(['JSESSIONID=s1']);
    expect(retomados).toEqual(['JSESSIONID=s1', 'JSESSIONID=s1']);
  });

  it('a sessão é da pessoa: outro cliente (outra obterCred) reaproveita sem abrir a senha', async () => {
    const { sessoes, obter, logins } = montar();
    await sessoes.usar(A, obter, async () => 1);
    const outroCliente = jest.fn(async () => ({ login: 'fulano', password: Secret.of('outra-copia') }));
    await sessoes.usar(A, outroCliente, async () => 2);
    expect(outroCliente).not.toHaveBeenCalled();
    expect(logins).toHaveLength(1);
  });

  it('depois de 20 min sem uso, loga de novo', async () => {
    const { sessoes, obter, avancar, logins } = montar();
    await sessoes.usar(A, obter, async () => 1);
    avancar(19 * MIN);
    await sessoes.usar(A, obter, async () => 2);
    expect(logins).toHaveLength(1);
    avancar(21 * MIN);
    await sessoes.usar(A, obter, async () => 3);
    expect(logins).toHaveLength(2);
    expect(obter).toHaveBeenCalledTimes(2);
  });

  it('o cookie guardado é cifrado (o store nunca vê o valor em claro)', async () => {
    const { sessoes, store, obter } = montar();
    await sessoes.usar(A, obter, async () => 1);
    const rec = await store.load(A);
    expect(rec?.cookie.ciphertext).toBeDefined();
    expect(JSON.stringify(rec)).not.toContain('JSESSIONID');
  });

  it('sessão expirada: reloga 1 vez e refaz; expirada de novo: lança e apaga a sessão', async () => {
    const { sessoes, obter, logins, store } = montar();
    let chamadas = 0;
    await expect(
      sessoes.usar(A, obter, async () => {
        if (++chamadas === 1) throw new SigaaSessionExpiredError();
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(logins).toHaveLength(2);
    expect(await store.load(A)).not.toBeNull();

    const outro = montar();
    let n = 0;
    await expect(
      outro.sessoes.usar(A, outro.obter, async () => {
        n++;
        throw new SigaaSessionExpiredError();
      }),
    ).rejects.toBeInstanceOf(SigaaSessionExpiredError);
    expect(n).toBe(2);
    expect(await outro.store.load(A)).toBeNull();
    void store;
  });

  it('expirou com a sessão guardada de antes: reloga com a senha aberta só agora', async () => {
    const { sessoes, obter, logins } = montar();
    await sessoes.usar(A, obter, async () => 1);
    let vez = 0;
    await sessoes.usar(A, obter, async () => {
      if (++vez === 1) throw new SigaaSessionExpiredError();
      return 2;
    });
    expect(obter).toHaveBeenCalledTimes(2);
    expect(logins).toHaveLength(2);
  });

  it('senha recusada no login apaga a sessão guardada e propaga o erro', async () => {
    const m = montar();
    await m.sessoes.usar(A, m.obter, async () => 1);
    m.avancar(21 * MIN);
    const recusa = montar({ store: m.store, login: () => Promise.reject(new SigaaInvalidCredentialsError()) });
    recusa.avancar(21 * MIN); // mesmo instante da outra (relógios separados nos dois montar)
    await expect(recusa.sessoes.usar(A, recusa.obter, async () => 2)).rejects.toBeInstanceOf(
      SigaaInvalidCredentialsError,
    );
    expect(await m.store.load(A)).toBeNull();
  });

  it('se obterCred falha (K que não abre), nada é guardado e o erro sobe', async () => {
    const { sessoes, store } = montar();
    await expect(
      sessoes.usar(
        A,
        async () => {
          throw new Error('k-ruim');
        },
        async () => 1,
      ),
    ).rejects.toThrow('k-ruim');
    expect(await store.load(A)).toBeNull();
  });

  it('duas chamadas simultâneas da mesma pessoa rodam em sequência e geram 1 login', async () => {
    const { sessoes, obter, logins } = montar();
    const eventos: string[] = [];
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const p1 = sessoes.usar(A, obter, async () => {
      eventos.push('1 inicio');
      await portao;
      eventos.push('1 fim');
    });
    const p2 = sessoes.usar(A, obter, async () => {
      eventos.push('2 inicio');
    });
    await new Promise((r) => setImmediate(r));
    expect(eventos).toEqual(['1 inicio']);
    liberar();
    await Promise.all([p1, p2]);
    expect(eventos).toEqual(['1 inicio', '1 fim', '2 inicio']);
    expect(logins).toHaveLength(1);
  });

  it('uma chamada que falha não trava a fila nem a trava da pessoa', async () => {
    const { sessoes, obter } = montar();
    const p1 = sessoes.usar(A, obter, async () => {
      throw new Error('boom');
    });
    const p2 = sessoes.usar(A, obter, async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('pessoas diferentes são independentes', async () => {
    const { sessoes, obter } = montar();
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const p1 = sessoes.usar(A, obter, () => portao);
    await expect(sessoes.usar(B, obter, async () => 'b')).resolves.toBe('b');
    liberar();
    await p1;
  });

  describe('entre instâncias (deploy com duas rodando)', () => {
    it('a segunda instância espera a trava da primeira e depois reaproveita a sessão (1 login)', async () => {
      const m = montar();
      const outra = montar({ store: m.store });
      // a "outra instância" compartilha o store e o relógio simulado
      const sessoes2 = new SessoesSigaa(outra.criar, m.store, cipher, {
        now: m.now,
        sleep: () => new Promise<void>((r) => setImmediate(r)),
      });
      const eventos: string[] = [];
      let liberar!: () => void;
      const portao = new Promise<void>((r) => (liberar = r));
      const p1 = m.sessoes.usar(A, m.obter, async () => {
        eventos.push('i1 inicio');
        await portao;
        eventos.push('i1 fim');
      });
      await new Promise((r) => setImmediate(r));
      const p2 = sessoes2.usar(A, m.obter, async () => {
        eventos.push('i2 inicio');
      });
      await new Promise((r) => setImmediate(r));
      expect(eventos).toEqual(['i1 inicio']);
      liberar();
      await Promise.all([p1, p2]);
      expect(eventos).toEqual(['i1 inicio', 'i1 fim', 'i2 inicio']);
      expect(m.logins).toHaveLength(1);
      expect(outra.logins).toHaveLength(0);
    });

    it('trava presa além do tempo de espera: SigaaOcupadoError (sem dado de ninguém)', async () => {
      const m = montar();
      await m.store.acquire(A, 10 * MIN); // outra execução segura a trava
      const err = await m.sessoes.usar(A, m.obter, async () => 1).catch((e) => e);
      expect(err).toBeInstanceOf(SigaaOcupadoError);
      expect(m.obter).not.toHaveBeenCalled();
    });

    it('trava de processo que morreu vence sozinha', async () => {
      const m = montar();
      await m.store.acquire(A, 2 * MIN);
      m.avancar(2 * MIN + 1);
      await expect(m.sessoes.usar(A, m.obter, async () => 'ok')).resolves.toBe('ok');
    });
  });

  it('falha ao gravar a sessão não derruba a consulta', async () => {
    const m = montar();
    m.store.save = () => Promise.reject(new Error('banco fora'));
    await expect(m.sessoes.usar(A, m.obter, async () => 'ok')).resolves.toBe('ok');
  });
});
