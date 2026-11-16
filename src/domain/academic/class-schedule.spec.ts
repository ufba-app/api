import { blockTimes, expandClass, parseSchedule } from './class-schedule';

describe('parseSchedule', () => {
  it('35T45 (período): terça e quinta, tarde, módulos 4 e 5', () => {
    expect(parseSchedule('35T45 (18/08/2026 - 19/12/2026)')).toEqual({
      blocks: [{ weekdays: [3, 5], shift: 'T', modules: [4, 5], invalidModules: [] }],
      period: { start: '2026-08-18', end: '2026-12-19' },
    });
  });

  it('vários blocos e sem período', () => {
    expect(parseSchedule('24M12 6T12')).toEqual({
      blocks: [
        { weekdays: [2, 4], shift: 'M', modules: [1, 2], invalidModules: [] },
        { weekdays: [6], shift: 'T', modules: [1, 2], invalidModules: [] },
      ],
      period: null,
    });
  });

  it('domingo (1) e sábado (7) valem; dia repetido e módulo repetido não duplicam', () => {
    expect(parseSchedule('177N1122')).toEqual({ blocks: [{ weekdays: [1, 7], shift: 'N', modules: [1, 2], invalidModules: [] }], period: null });
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
    expect(parseSchedule('2M7 3T12')!.blocks).toEqual([{ weekdays: [3], shift: 'T', modules: [1, 2], invalidModules: [] }]);
  });

  // Como o app antigo (schedule-code.spec): módulo que o turno não tem é IGNORADO sozinho e fica em invalidModules.
  it('módulo inexistente no turno vai para invalidModules em vez de derrubar o bloco ("2N45": a noite só tem 4)', () => {
    expect(parseSchedule('2N45')!.blocks).toEqual([{ weekdays: [2], shift: 'N', modules: [4], invalidModules: [5] }]);
  });

  it('vários módulos inválidos misturados aos válidos: os válidos ficam, os outros são guardados', () => {
    expect(parseSchedule('35M1789')!.blocks).toEqual([{ weekdays: [3, 5], shift: 'M', modules: [1], invalidModules: [7, 8, 9] }]);
  });

  it('dígito de dia inválido é ignorado sozinho; os dias válidos do bloco ficam', () => {
    expect(parseSchedule('280M12')!.blocks).toEqual([{ weekdays: [2], shift: 'M', modules: [1, 2], invalidModules: [] }]);
  });

  it('módulos fora de ordem são ordenados ("2N43" = "2N34")', () => {
    expect(parseSchedule('2N43')!.blocks[0].modules).toEqual([3, 4]);
  });

  it('as faixas do app antigo: "2M136" = 07:00–07:55, 08:50–09:45 e 11:35–12:30 (módulos não consecutivos viram faixas separadas)', () => {
    const [b] = parseSchedule('2M136')!.blocks;
    expect(blockTimes(b)).toEqual([
      { start: '07:00', end: '07:55' },
      { start: '08:50', end: '09:45' },
      { start: '11:35', end: '12:30' },
    ]);
  });

  it('a tabela de horas é idêntica à SLOT_MINUTES do app antigo, módulo a módulo', () => {
    // [início, fim] em minutos desde 00:00 por turno e módulo: copiado de sigaa-engine/schedule-code.ts do app antigo.
    const antigo: Record<string, Array<[number, number]>> = {
      M: [[420, 475], [475, 530], [530, 585], [585, 640], [640, 695], [695, 750]],
      T: [[780, 835], [835, 890], [890, 945], [945, 1000], [1000, 1055], [1055, 1110]],
      N: [[1110, 1165], [1165, 1220], [1220, 1275], [1275, 1330]],
    };
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const [shift, slots] of Object.entries(antigo)) {
      slots.forEach(([a, b], i) => {
        const block = { weekdays: [2], shift: shift as 'M' | 'T' | 'N', modules: [i + 1], invalidModules: [] };
        expect(blockTimes(block)).toEqual([{ start: hhmm(a), end: hhmm(b) }]);
      });
    }
  });

  it('período inválido (data impossível ou invertido) vira null, sem derrubar o horário', () => {
    expect(parseSchedule('2M12 (31/02/2026 - 19/12/2026)')!.period).toBeNull();
    expect(parseSchedule('2M12 (19/12/2026 - 18/08/2026)')!.period).toBeNull();
  });
});

describe('blockTimes: módulos de 55 min contínuos a partir de 07:00, 13:00 e 18:30', () => {
  it.each([
    [{ weekdays: [2], shift: 'M' as const, modules: [1], invalidModules: [] }, [{ start: '07:00', end: '07:55' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [1, 2], invalidModules: [] }, [{ start: '07:00', end: '08:50' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [6], invalidModules: [] }, [{ start: '11:35', end: '12:30' }]],
    [{ weekdays: [2], shift: 'T' as const, modules: [4, 5], invalidModules: [] }, [{ start: '15:45', end: '17:35' }]],
    [{ weekdays: [2], shift: 'T' as const, modules: [6], invalidModules: [] }, [{ start: '17:35', end: '18:30' }]],
    [{ weekdays: [2], shift: 'N' as const, modules: [1, 2], invalidModules: [] }, [{ start: '18:30', end: '20:20' }]], // 24N12 = 18:30 às 20:20 (UFBA)
    [{ weekdays: [2], shift: 'N' as const, modules: [4], invalidModules: [] }, [{ start: '21:15', end: '22:10' }]],
    [{ weekdays: [2], shift: 'M' as const, modules: [1, 3], invalidModules: [] }, [{ start: '07:00', end: '07:55' }, { start: '08:50', end: '09:45' }]],
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
    expect(r[0]).toEqual({ date: '2026-08-18', weekday: 3, start: '15:45', end: '17:35' });
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
