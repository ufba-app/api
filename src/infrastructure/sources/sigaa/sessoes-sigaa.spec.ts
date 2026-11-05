import { SessoesSigaa } from './sessoes-sigaa';
import {
  SigaaInvalidCredentialsError,
  SigaaSessionExpiredError,
  type SigaaSession,
} from './session';

const cred = { login: 'fulano', password: 'senha-falsa' };
const MIN = 60_000;

function fake(login: () => Promise<void> = () => Promise.resolve()) {
  return { login: jest.fn(login) } as unknown as SigaaSession;
}

function montar(login?: () => Promise<void>) {
  let agora = 0;
  const criar = jest.fn(() => fake(login));
  const sessoes = new SessoesSigaa(criar, { now: () => agora });
  return { sessoes, criar, avancar: (ms: number) => (agora += ms) };
}

describe('SessoesSigaa', () => {
  it('segunda consulta em 20 min reaproveita a sessão (1 login)', async () => {
    const { sessoes, criar, avancar } = montar();
    await sessoes.usar('a', cred, async () => 1);
    avancar(19 * MIN);
    await sessoes.usar('a', cred, async () => 2);
    expect(criar).toHaveBeenCalledTimes(1);
  });

  it('depois de 20 min sem uso, loga de novo', async () => {
    const { sessoes, criar, avancar } = montar();
    await sessoes.usar('a', cred, async () => 1);
    avancar(21 * MIN);
    await sessoes.usar('a', cred, async () => 2);
    expect(criar).toHaveBeenCalledTimes(2);
  });

  it('duas chamadas simultâneas na mesma chave rodam em sequência', async () => {
    const { sessoes } = montar();
    const eventos: string[] = [];
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const p1 = sessoes.usar('a', cred, async () => {
      eventos.push('1 inicio');
      await portao;
      eventos.push('1 fim');
    });
    const p2 = sessoes.usar('a', cred, async () => {
      eventos.push('2 inicio');
    });
    await new Promise((r) => setImmediate(r));
    expect(eventos).toEqual(['1 inicio']);
    liberar();
    await Promise.all([p1, p2]);
    expect(eventos).toEqual(['1 inicio', '1 fim', '2 inicio']);
  });

  it('uma chamada que falha não trava a fila da chave', async () => {
    const { sessoes } = montar();
    const p1 = sessoes.usar('a', cred, async () => {
      throw new Error('boom');
    });
    const p2 = sessoes.usar('a', cred, async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('chaves diferentes são independentes', async () => {
    const { sessoes, criar } = montar();
    let liberar!: () => void;
    const portao = new Promise<void>((r) => (liberar = r));
    const p1 = sessoes.usar('a', cred, () => portao);
    await expect(sessoes.usar('b', cred, async () => 'b')).resolves.toBe('b');
    liberar();
    await p1;
    expect(criar).toHaveBeenCalledTimes(2);
  });

  it('sessão expirada: reloga 1 vez e refaz; expirada de novo: lança', async () => {
    const { sessoes, criar } = montar();
    let chamadas = 0;
    await expect(
      sessoes.usar('a', cred, async () => {
        if (++chamadas === 1) throw new SigaaSessionExpiredError();
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(criar).toHaveBeenCalledTimes(2);

    const outro = montar();
    let n = 0;
    await expect(
      outro.sessoes.usar('a', cred, async () => {
        n++;
        throw new SigaaSessionExpiredError();
      }),
    ).rejects.toBeInstanceOf(SigaaSessionExpiredError);
    expect(n).toBe(2);
    expect(outro.criar).toHaveBeenCalledTimes(2);
  });

  it('credencial inválida: lança, esquece a sessão e NÃO tenta de novo', async () => {
    let falhar = true;
    const { sessoes, criar } = montar(async () => {
      if (falhar) throw new SigaaInvalidCredentialsError();
    });
    const fn = jest.fn(async () => 1);
    await expect(sessoes.usar('a', cred, fn)).rejects.toBeInstanceOf(
      SigaaInvalidCredentialsError,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(criar).toHaveBeenCalledTimes(1);
    falhar = false;
    await sessoes.usar('a', cred, fn);
    expect(criar).toHaveBeenCalledTimes(2);
  });

  it('esquecer força novo login', async () => {
    const { sessoes, criar } = montar();
    await sessoes.usar('a', cred, async () => 1);
    sessoes.esquecer('a');
    await sessoes.usar('a', cred, async () => 1);
    expect(criar).toHaveBeenCalledTimes(2);
  });
});
