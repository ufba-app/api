import { blockTimes, expandClass, parseSchedule } from './class-schedule';

describe('parseSchedule', () => {
  it('35T45 (período): terça e quinta, tarde, módulos 4 e 5', () => {
    expect(parseSchedule('35T45 (18/08/2026 - 19/12/2026)')).toEqual({
      blocks: [{ weekdays: [3, 5], shift: 'T', modules: [4, 5] }],
      period: { start: '2026-08-18', end: '2026-12-19' },
    });
  });

  it('vários blocos e sem período', () => {
    expect(parseSchedule('24M12 6T12')).toEqual({
      blocks: [
        { weekdays: [2, 4], shift: 'M', modules: [1, 2] },
        { weekdays: [6], shift: 'T', modules: [1, 2] },
      ],
      period: null,
    });
  });

  it('domingo (1) e sábado (7) valem; dia repetido e módulo repetido não duplicam', () => {
    expect(parseSchedule('177N1122')).toEqual({ blocks: [{ weekdays: [1, 7], shift: 'N', modules: [1, 2] }], period: null });
  });

  it.each([
    ['dia 8', '8M12'],
    ['dia 0', '0M12'],
    ['módulo 7 na manhã', '2M7'],
    ['módulo 5 na noite', '2N5'],
    ['sem código', 'Sala 12'],
    ['vazio', ''],
  ])('descarta o que o turno não tem (%s)', (_n, text) => {
    expect(parseSchedule(text)).toBeNull();
  });

  it('um bloco inválido não derruba os válidos', () => {
    expect(parseSchedule('2M7 3T12')!.blocks).toEqual([{ weekdays: [3], shift: 'T', modules: [1, 2] }]);
  });

  it('período inválido (data impossível ou invertido) vira null, sem derrubar o horário', () => {
    expect(parseSchedule('2M12 (31/02/2026 - 19/12/2026)')!.period).toBeNull();
    expect(parseSchedule('2M12 (19/12/2026 - 18/08/2026)')!.period).toBeNull();
  });
});

describe('blockTimes: módulos de 55 min contínuos a partir de 07:00, 13:00 e 18:30', () => {
  it.each([
    [{ weekdays: [2], shift: 'M' as const, modules: [1] }, [{ start: '07:00', end: '07:55' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [1, 2] }, [{ start: '07:00', end: '08:50' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [6] }, [{ start: '11:35', end: '12:30' }]],
    [{ weekdays: [2], shift: 'T' as const, modules: [4, 5] }, [{ start: '15:45', end: '17:35' }]],
    [{ weekdays: [2], shift: 'T' as const, modules: [6] }, [{ start: '17:35', end: '18:30' }]],
    [{ weekdays: [2], shift: 'N' as const, modules: [1, 2] }, [{ start: '18:30', end: '20:20' }]], // 24N12 = 18:30 às 20:20 (UFBA)
    [{ weekdays: [2], shift: 'N' as const, modules: [4] }, [{ start: '21:15', end: '22:10' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [1, 3] }, [{ start: '07:00', end: '07:55' }, { start: '08:50', end: '09:45' }]],
  ])('%j', (b, esperado) => {
    expect(blockTimes(b)).toEqual(esperado);
  });
});

describe('expandClass', () => {
  const s = parseSchedule('35T45 (18/08/2026 - 19/12/2026)')!;
  const never = () => false;

  it('só nos dias da semana da turma, dentro do intervalo pedido e do período da turma', () => {
    const r = expandClass(s, '2026-08-10', '2026-08-31', never);
    expect(r.map((o) => o.date)).toEqual(['2026-08-18', '2026-08-20', '2026-08-25', '2026-08-27']); // antes de 18/08 não
    expect(r[0]).toEqual({ date: '2026-08-18', start: '15:45', end: '17:35' });
    expect(expandClass(s, '2026-12-17', '2027-01-10', never).map((o) => o.date)).toEqual(['2026-12-17']); // depois de 19/12 não
  });

  it('o predicado exclui feriados e dias sem aula', () => {
    const off = new Set(['2026-08-20', '2026-08-25']);
    expect(expandClass(s, '2026-08-18', '2026-08-27', (d) => off.has(d)).map((o) => o.date)).toEqual(['2026-08-18', '2026-08-27']);
  });

  it('sem período próprio usa o de reserva; sem nenhum, nada', () => {
    const sp = parseSchedule('3M12')!;
    expect(expandClass(sp, '2026-11-01', '2026-11-30', never)).toEqual([]);
    expect(expandClass(sp, '2026-11-01', '2026-11-30', never, { start: '2026-11-10', end: '2026-11-17' }).map((o) => o.date)).toEqual(['2026-11-10', '2026-11-17']);
  });

  it('o período da turma manda sobre o de reserva', () => {
    const own = parseSchedule('3M12 (01/11/2026 - 10/11/2026)')!;
    expect(expandClass(own, '2026-11-01', '2026-11-30', never, { start: '2026-11-01', end: '2026-11-30' }).map((o) => o.date)).toEqual(['2026-11-03', '2026-11-10']);
  });

  it('dois blocos no mesmo dia saem ordenados pela hora', () => {
    const two = parseSchedule('3T12 3M12 (01/11/2026 - 30/11/2026)')!;
    expect(expandClass(two, '2026-11-03', '2026-11-03', never).map((o) => o.start)).toEqual(['07:00', '13:00']);
  });
});
