import { DownloadLinks, MAX_USOS } from './download-links';

const T = { userId: 'u1', provider: 'MOODLE' as const, conta: 'c', ref: 'r' };

describe('DownloadLinks', () => {
  it('uso único por padrão', () => {
    const l = new DownloadLinks();
    const { id } = l.criar(T);
    expect(l.consumir(id)).toMatchObject({ userId: 'u1', usosRestantes: 0 });
    expect(l.consumir(id)).toBeUndefined();
  });

  it('com usos: vale N vezes e depois some; o teto é MAX_USOS', () => {
    const l = new DownloadLinks();
    const { id } = l.criar({ ...T, usos: 3 });
    expect([l.consumir(id), l.consumir(id), l.consumir(id), l.consumir(id)].map((x) => x !== undefined)).toEqual([true, true, true, false]);
    const grande = l.criar({ ...T, usos: 999 });
    let n = 0;
    while (l.consumir(grande.id)) n++;
    expect(n).toBe(MAX_USOS);
    const zero = l.criar({ ...T, usos: 0 });
    expect(l.consumir(zero.id)).toBeDefined();
    expect(l.consumir(zero.id)).toBeUndefined();
  });

  it('expira (mesmo com usos sobrando)', () => {
    let t = 1000;
    const l = new DownloadLinks(60_000, () => t);
    const { id } = l.criar({ ...T, usos: 3 });
    t += 60_001;
    expect(l.espiar(id)).toBeUndefined();
    expect(l.consumir(id)).toBeUndefined();
  });

  it('espiar não gasta uso', () => {
    const l = new DownloadLinks();
    const { id } = l.criar(T);
    expect(l.espiar(id)).toBeDefined();
    expect(l.espiar(id)).toBeDefined();
    expect(l.consumir(id)).toBeDefined();
    expect(l.espiar(id)).toBeUndefined();
  });

  it('o ticket devolvido é cópia: mexer nele não altera os usos', () => {
    const l = new DownloadLinks();
    const { id } = l.criar({ ...T, usos: 2 });
    const t = l.espiar(id)!;
    t.usosRestantes = 99;
    expect(l.espiar(id)!.usosRestantes).toBe(2);
  });
});
