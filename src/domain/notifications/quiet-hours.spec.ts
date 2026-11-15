import { inQuietHours } from './quiet-hours';

// Bahia = UTC-3: 21:59 na Bahia é 00:59Z do dia seguinte.
const bahia = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00-03:00`);

describe('inQuietHours (22h-7h na Bahia)', () => {
  it.each([
    ['21:59', false],
    ['22:00', true],
    ['23:59', true],
    ['00:00', true],
    ['06:59', true],
    ['07:00', false],
    ['12:00', false],
  ])('%s → %s', (hhmm, quiet) => {
    expect(inQuietHours(bahia(hhmm))).toBe(quiet);
  });

  it('não depende do fuso da máquina: vale o instante UTC', () => {
    expect(inQuietHours(new Date('2026-11-18T00:59:00Z'))).toBe(false); // 21:59 na Bahia
    expect(inQuietHours(new Date('2026-11-18T01:00:00Z'))).toBe(true); // 22:00
    expect(inQuietHours(new Date('2026-11-18T09:59:00Z'))).toBe(true); // 06:59
    expect(inQuietHours(new Date('2026-11-18T10:00:00Z'))).toBe(false); // 07:00
  });
});
