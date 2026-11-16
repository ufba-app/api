import { inQuietHours } from '../notifications/quiet-hours';
import {
  ALERT_GAP_MS,
  alertChain,
  chainSlotAtOrBefore,
  lastAlertAt,
  latestDue,
  MIN_GAP_TO_LAST_MS,
  nextAwakeInstant,
  unscheduledSlot,
} from './alert-schedule';

const H = 3_600_000;
/** Instante a partir de um horário da Bahia (UTC-3). */
const ba = (s: string) => new Date(`${s}-03:00`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('lastAlertAt', () => {
  it('prazo quarta 10h: último aviso na terça 19h', () => {
    expect(iso(lastAlertAt(ba('2026-11-25T10:00:00')))).toBe(iso(ba('2026-11-24T19:00:00')));
  });
  it('prazo 8h: último na terça 17h', () => {
    expect(iso(lastAlertAt(ba('2026-11-25T08:00:00')))).toBe(iso(ba('2026-11-24T17:00:00')));
  });
  it('prazo 15h: último às 9h do mesmo dia', () => {
    expect(iso(lastAlertAt(ba('2026-11-25T15:00:00')))).toBe(iso(ba('2026-11-25T09:00:00')));
  });
  it('prazo dentro do silêncio conta a partir das 22h anteriores', () => {
    expect(iso(lastAlertAt(ba('2026-11-25T03:00:00')))).toBe(iso(ba('2026-11-24T16:00:00')));
  });
});

describe('nextAwakeInstant', () => {
  it('devolve o próprio instante se acordado', () => {
    const at = ba('2026-11-25T12:30:00');
    expect(nextAwakeInstant(at)).toEqual(at);
  });
  it('no silêncio vale as 7h da Bahia seguintes', () => {
    expect(iso(nextAwakeInstant(ba('2026-11-25T23:10:00')))).toBe(iso(ba('2026-11-26T07:00:00')));
    expect(iso(nextAwakeInstant(ba('2026-11-25T03:00:00')))).toBe(iso(ba('2026-11-25T07:00:00')));
  });
});

describe('alertChain', () => {
  const deadline = ba('2026-11-25T10:00:00'); // último: terça 19h
  const wide = { after: ba('2026-01-01T00:00:00'), upTo: ba('2026-12-31T00:00:00') };

  it('recua de 36 em 36 h a partir do último', () => {
    const chain = alertChain(deadline, wide.after, wide.upTo);
    const last = chain[chain.length - 1];
    expect(iso(last)).toBe(iso(ba('2026-11-24T19:00:00')));
    // 36 h antes: domingo 07h (acordado, intacto); depois sexta 19h.
    expect(iso(chain[chain.length - 2])).toBe(iso(ba('2026-11-23T07:00:00')));
    expect(iso(chain[chain.length - 3])).toBe(iso(ba('2026-11-21T19:00:00')));
  });

  it('o que cairia no silêncio recua para antes das 22h do dia anterior', () => {
    // último 2026-11-25T09:00 (prazo 15h); -36h = 2026-11-23T21:00 (acordado); -72h = 2026-11-22T09:00.
    // Prazo 12h → último 06h? não: 12h-6h = 06h cai antes das 7h, logo prazo 12h → último 06:00? vide abaixo.
    // Escolhemos prazo tal que last - 36 h cai às 03h: last = 15h → prazo 21h.
    const d = ba('2026-11-25T21:00:00'); // último 15h; -36h = 03h de 2026-11-24 (silêncio)
    const chain = alertChain(d, wide.after, wide.upTo);
    expect(iso(chain[chain.length - 1])).toBe(iso(ba('2026-11-25T15:00:00')));
    expect(iso(chain[chain.length - 2])).toBe(iso(ba('2026-11-23T21:00:00')));
  });

  it('o recorte muda, a cadeia não', () => {
    const full = alertChain(deadline, wide.after, wide.upTo);
    const cut = alertChain(deadline, full[1], full[full.length - 2]);
    expect(cut.map(iso)).toEqual(full.slice(2, full.length - 1).map(iso));
    // `after` exclusivo, `upTo` inclusivo.
    expect(alertChain(deadline, full[0], full[0])).toEqual([]);
    expect(alertChain(deadline, new Date(full[0].getTime() - 1), full[0]).map(iso)).toEqual([iso(full[0])]);
  });

  it('é finita mesmo com `after` muito no passado (corta 60 dias antes do prazo)', () => {
    const chain = alertChain(deadline, new Date(0), new Date('2100-01-01T00:00:00Z'));
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThanOrEqual(60);
    expect(chain[0].getTime()).toBeGreaterThanOrEqual(deadline.getTime() - 61 * 24 * H);
  });

  it('prazo muito próximo: o último aviso aparece se > after e <= upTo', () => {
    const last = lastAlertAt(deadline);
    const justAfter = new Date(last.getTime() + H);
    expect(alertChain(deadline, new Date(last.getTime() - H), justAfter).map(iso)).toContain(iso(last));
    expect(alertChain(deadline, last, justAfter)).toEqual([]);
  });
});

describe('alertChain: propriedades', () => {
  const base = ba('2026-11-20T00:00:00').getTime();
  const deadlines: Date[] = [];
  for (let i = 0; i < 24 * 6; i++) deadlines.push(new Date(base + i * H));
  const after = ba('2026-01-01T00:00:00');
  const upTo = ba('2027-01-01T00:00:00');

  it('nenhum instante em silêncio; estritamente crescente; vãos >= 12 h; termina no último aviso', () => {
    for (const d of deadlines) {
      const chain = alertChain(d, after, upTo);
      expect(chain.length).toBeGreaterThan(0);
      for (let i = 0; i < chain.length; i++) {
        expect(inQuietHours(chain[i])).toBe(false);
        if (i > 0) expect(chain[i].getTime() - chain[i - 1].getTime()).toBeGreaterThanOrEqual(MIN_GAP_TO_LAST_MS);
      }
      expect(chain[chain.length - 1].getTime()).toBe(lastAlertAt(d).getTime());
      expect(inQuietHours(lastAlertAt(d))).toBe(false);
      expect(lastAlertAt(d).getTime()).toBeLessThan(d.getTime());
    }
  });

  it('recortes diferentes dão subconjuntos consistentes da mesma cadeia', () => {
    for (const d of deadlines) {
      const full = alertChain(d, after, upTo);
      const mid = full[Math.floor(full.length / 2)];
      const a = alertChain(d, new Date(mid.getTime() - 5 * H), upTo);
      const b = alertChain(d, new Date(mid.getTime() - 50 * H), new Date(mid.getTime() + 1));
      for (const x of [...a, ...b]) expect(full.map(iso)).toContain(iso(x));
      expect(a.map(iso)).toEqual(full.filter((x) => x.getTime() > mid.getTime() - 5 * H).map(iso));
    }
  });
});

describe('chainSlotAtOrBefore', () => {
  const deadline = ba('2026-12-20T10:00:00');
  it('com prazo distante devolve um instante da cadeia, anterior ou igual ao pedido', () => {
    const at = ba('2026-12-05T13:00:00');
    const slot = chainSlotAtOrBefore(deadline, at);
    expect(slot).not.toBeNull();
    expect(slot!.getTime()).toBeLessThanOrEqual(at.getTime());
    const chain = alertChain(deadline, new Date(0), new Date('2100-01-01T00:00:00Z'));
    expect(chain.map(iso)).toContain(iso(slot));
    // e é o mais recente: nenhum outro da cadeia entre ele e `at`.
    expect(chain.filter((x) => x.getTime() > slot!.getTime() && x.getTime() <= at.getTime())).toEqual([]);
  });
  it('igual ao instante quando `at` é um instante da cadeia', () => {
    const chain = alertChain(deadline, new Date(0), new Date('2100-01-01T00:00:00Z'));
    expect(iso(chainSlotAtOrBefore(deadline, chain[3]))).toBe(iso(chain[3]));
  });
  it('null antes do primeiro instante possível', () => {
    expect(chainSlotAtOrBefore(deadline, ba('2026-01-01T00:00:00'))).toBeNull();
  });
  it('é estável: detectar em momentos diferentes dá o mesmo instante', () => {
    const a = chainSlotAtOrBefore(deadline, ba('2026-12-05T13:00:00'));
    const b = chainSlotAtOrBefore(deadline, ba('2026-12-05T13:07:41'));
    expect(iso(a)).toBe(iso(b));
  });
});

describe('latestDue', () => {
  const s = [ba('2026-11-20T10:00:00'), ba('2026-11-21T10:00:00'), ba('2026-11-22T10:00:00'), ba('2026-11-23T10:00:00')];
  it('devolve só o mais recente devido e os anteriores em skipped', () => {
    const r = latestDue(s, ba('2026-11-22T12:00:00'));
    expect(iso(r.due)).toBe(iso(s[2]));
    expect(r.skipped.map(iso)).toEqual([iso(s[0]), iso(s[1])]);
  });
  it('nenhum devido', () => {
    expect(latestDue(s, ba('2026-11-19T00:00:00'))).toEqual({ due: null, skipped: [] });
  });
  it('um devido, sem skipped', () => {
    const r = latestDue(s, ba('2026-11-20T10:00:00'));
    expect(iso(r.due)).toBe(iso(s[0]));
    expect(r.skipped).toEqual([]);
  });
});

describe('unscheduledSlot', () => {
  const last = ba('2026-11-20T10:00:00');
  it('null antes de last + 36 h', () => {
    expect(unscheduledSlot(last, ba('2026-11-20T10:00:00'))).toBeNull();
    expect(unscheduledSlot(last, new Date(last.getTime() + ALERT_GAP_MS - 1))).toBeNull();
  });
  it('a cada 36 h a partir de last', () => {
    // last + 36 h = 2026-11-21T22:00 (silêncio) -> 07h do dia seguinte; escolha last às 12h para cair acordado.
    const l = ba('2026-11-20T12:00:00'); // +36 h = 22-11 00:00 (silêncio) -> vale 07:00
    expect(iso(unscheduledSlot(l, ba('2026-11-22T07:00:00')))).toBe(iso(ba('2026-11-22T07:00:00')));
    const l2 = ba('2026-11-20T09:00:00'); // +36 h = 21-11 21:00 acordado
    expect(iso(unscheduledSlot(l2, ba('2026-11-21T21:00:00')))).toBe(iso(ba('2026-11-21T21:00:00')));
    expect(iso(unscheduledSlot(l2, ba('2026-11-23T08:00:00')))).toBe(iso(ba('2026-11-21T21:00:00')));
    // +72 h = 23-11 09:00
    expect(iso(unscheduledSlot(l2, ba('2026-11-23T09:00:00')))).toBe(iso(ba('2026-11-23T09:00:00')));
  });
  it('no silêncio, o aviso só vale a partir das 7h seguintes', () => {
    const l = ba('2026-11-20T12:00:00'); // +36 h = 2026-11-22T00:00
    expect(unscheduledSlot(l, ba('2026-11-22T06:59:00'))).toBeNull();
    expect(iso(unscheduledSlot(l, ba('2026-11-22T07:00:00')))).toBe(iso(ba('2026-11-22T07:00:00')));
  });
});
