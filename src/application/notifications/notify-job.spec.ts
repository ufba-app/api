import type { AlertProvider, AlertResult } from './alert-provider';
import { runNotifyJob } from './notify-job';

const res = (over: Partial<AlertResult> = {}): AlertResult => ({ sent: 0, suppressed: 0, skipped: 0, failed: 0, ...over });
const provider = (key: string, users: string[] | Error, eval_: (id: string) => AlertResult | Error = () => res({ skipped: 1 })): AlertProvider => ({
  key,
  usersToEvaluate: async () => {
    if (users instanceof Error) throw users;
    return users;
  },
  evaluateUser: async (id) => {
    const r = eval_(id);
    if (r instanceof Error) throw r;
    return r;
  },
});

describe('runNotifyJob', () => {
  it('sem provedor registrado: roda, loga e sai 0', async () => {
    const out: string[] = [];
    expect(await runNotifyJob({ providers: [] }, (l) => out.push(l))).toBe(0);
    expect(out).toEqual(['notify: nenhum provedor de avisos registrado']);
  });

  it('soma as contagens por provedor e sai 0; passa o instante da rodada', async () => {
    const out: string[] = [];
    const seen: Date[] = [];
    const now = new Date('2026-11-18T12:00:00Z');
    const p = provider('siasb', ['u1', 'u2', 'u3'], () => res({ sent: 2, suppressed: 1, skipped: 3, failed: 1 }));
    const spy = jest.spyOn(p, 'evaluateUser').mockImplementation(async (_id, at) => (seen.push(at), res({ sent: 2, suppressed: 1, skipped: 3, failed: 1 })));
    expect(await runNotifyJob({ providers: [p], now: () => now }, (l) => out.push(l))).toBe(0);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([now, now, now]);
    expect(out).toEqual(['notify[siasb]: 3 pessoas, 6 enviados, 3 suprimidos, 9 pulados, 3 falhas']);
  });

  it('erro numa pessoa não derruba as demais (conta como falha); erro num provedor não derruba os outros', async () => {
    const out: string[] = [];
    const a = provider('a', ['u1', 'u2', 'u3'], (id) => (id === 'u2' ? new Error('segredo-que-nao-pode-vazar') : res({ sent: 1 })));
    const b = provider('b', new Error('banco caiu'));
    const c = provider('c', ['u9'], () => res({ sent: 1 }));
    expect(await runNotifyJob({ providers: [a, b, c] }, (l) => out.push(l))).toBe(0);
    expect(out).toEqual([
      'notify[a]: 3 pessoas, 2 enviados, 0 suprimidos, 0 pulados, 1 falhas',
      'notify[b]: não foi possível listar quem avaliar',
      'notify[c]: 1 pessoas, 1 enviados, 0 suprimidos, 0 pulados, 0 falhas',
    ]);
  });

  it('só loga contagens: nunca id de pessoa nem a mensagem de erro', async () => {
    const out: string[] = [];
    const p = provider('x', ['pessoa-123'], () => new Error('texto-do-aviso'));
    await runNotifyJob({ providers: [p, provider('y', new Error('detalhe-interno'))] }, (l) => out.push(l));
    expect(out.join('\n')).not.toMatch(/pessoa-123|texto-do-aviso|detalhe-interno/);
  });

  it('resultado malformado de um provedor conta como zero, sem derrubar', async () => {
    const out: string[] = [];
    const p = provider('m', ['u1'], () => ({ sent: NaN, suppressed: -2, skipped: 'x' } as unknown as AlertResult));
    expect(await runNotifyJob({ providers: [p] }, (l) => out.push(l))).toBe(0);
    expect(out[0]).toBe('notify[m]: 1 pessoas, 0 enviados, 0 suprimidos, 0 pulados, 0 falhas');
  });

  it('sai 1 só se não deu para listar as pessoas de NENHUM provedor', async () => {
    expect(await runNotifyJob({ providers: [provider('a', new Error('x')), provider('b', new Error('y'))] }, () => undefined)).toBe(1);
    expect(await runNotifyJob({ providers: [provider('a', new Error('x')), provider('b', [])] }, () => undefined)).toBe(0);
  });
});
