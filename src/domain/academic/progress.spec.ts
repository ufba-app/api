import {
  buildProgress,
  crossCheckTranscript,
  parseHistoryEquivalences,
  type CurriculumComponentInput,
  type CurriculumInput,
  type TranscriptEntryInput,
  type TranscriptInput,
} from './progress';

const comp = (code: string, o: Partial<CurriculumComponentInput> = {}): CurriculumComponentInput => ({
  code,
  name: `Componente ${code}`,
  hours: 60,
  nature: 'REQUIRED',
  term: 1,
  prerequisiteExpr: null,
  corequisiteExpr: null,
  equivalenceExpr: null,
  ...o,
});

const entry = (code: string, status: string, o: Partial<TranscriptEntryInput> = {}): TranscriptEntryInput => ({
  term: '2024.1',
  nature: 'OB',
  code,
  name: `Componente ${code}`,
  hours: 60,
  grade: status === 'APR' ? 7 : null,
  status,
  ...o,
});

// Currículo Ativo fictício.
const CURRICULUM: CurriculumInput = {
  code: 'G20251',
  totalHours: 480,
  requiredHours: 300,
  minElectiveHours: 120,
  minComplementaryHours: 60,
  minTerms: 8,
  avgTerms: 10,
  maxTerms: 14,
  components: [
    comp('MAT01', { equivalenceExpr: '( MAT01A )' }),
    comp('FIS01'),
    comp('MAT02', { term: 2, prerequisiteExpr: '( MAT01 )' }),
    comp('PROG1', { term: 2, prerequisiteExpr: '( MAT01 E FIS01 )' }),
    comp('PROG2', { term: 3, prerequisiteExpr: '( PROG1 )' }),
    comp('ELE01', { nature: 'ELECTIVE', term: null, hours: 45, prerequisiteExpr: '( MAT02 )' }),
    comp('ELE02', { nature: 'ELECTIVE', term: null, hours: 30 }),
    comp('ELE03', { nature: 'ELECTIVE', term: null, hours: 30, prerequisiteExpr: 'CH mínima 1500h' }),
    comp('COM01', { nature: 'COMPLEMENTARY', term: null, hours: 20 }),
  ],
};

const TRANSCRIPT: TranscriptInput = {
  entries: [
    entry('MAT01A', 'APR'), // código antigo: o Ativo declara MAT01 equivalente a ele
    entry('FIS01', 'APR'),
    entry('MAT02', 'MATR'),
    entry('ELE02', 'APR', { nature: 'OP', hours: 30 }),
    entry('INFX10', 'APR'), // o histórico declara que cumpriu PROG1 através dele
  ],
  pending: [
    { code: 'MAT02', name: 'x', hours: 60, enrolled: true },
    { code: 'PROG2', name: 'x', hours: 60, enrolled: false },
    { code: 'PROG1', name: 'x', hours: 60, enrolled: false },
    { code: 'OLD77', name: 'obsoleta pura', hours: 60, enrolled: false },
    { code: 'ENADE', name: 'ENADE', hours: 0, enrolled: false },
  ],
  hours: {
    mandatory: { required: 360, completed: 180, pending: 180 },
    elective: { required: 120, completed: 30, pending: 90 },
    complementary: { required: 60, completed: 20, pending: 40 },
    total: { required: 540, completed: 230, pending: 310 },
  },
  equivalences: ['Cumpriu PROG1 através de INFX10 (60h)'],
  currentTerm: 4,
  curriculumCode: 'G20251 - 2025.2',
};

const find = <T extends { code: string }>(list: T[], code: string): T => list.find((c) => c.code === code)!;

describe('parseHistoryEquivalences', () => {
  it('lê "Cumpriu X através de Y" e ignora o resto', () => {
    expect(parseHistoryEquivalences(['Cumpriu PROG1 através de INFX10 (60h)', 'texto qualquer', 'cumpriu abcd01 atraves de efgh02'])).toEqual([
      { fulfilled: 'PROG1', through: 'INFX10' },
      { fulfilled: 'ABCD01', through: 'EFGH02' },
    ]);
  });
});

describe('buildProgress', () => {
  const p = buildProgress(TRANSCRIPT, CURRICULUM);

  it('cumprido no próprio código: DONE', () => {
    expect(find(p.required, 'FIS01')).toMatchObject({ state: 'DONE', via: [] });
    expect(find(p.electives, 'ELE02').state).toBe('DONE');
  });

  it('o Ativo declara equivalência com um código antigo que o aluno cumpriu: DONE_VIA_EQUIVALENCE', () => {
    expect(find(p.required, 'MAT01')).toMatchObject({ state: 'DONE_VIA_EQUIVALENCE', via: ['MAT01A'] });
  });

  it('o histórico declara "Cumpriu X através de Y": DONE_VIA_EQUIVALENCE', () => {
    expect(find(p.required, 'PROG1')).toMatchObject({ state: 'DONE_VIA_EQUIVALENCE', via: ['INFX10'] });
  });

  it('matriculado: ENROLLED', () => {
    expect(find(p.required, 'MAT02').state).toBe('ENROLLED');
  });

  it('pré-requisito atendido (inclusive por equivalência): AVAILABLE', () => {
    expect(find(p.required, 'PROG2')).toMatchObject({ state: 'AVAILABLE', late: true }); // semestre 3 e o aluno está no 4º
  });

  it('pré-requisito não atendido: BLOCKED e diz o que falta (matrícula em andamento não conta)', () => {
    expect(find(p.electives, 'ELE01')).toMatchObject({ state: 'BLOCKED', missingPrerequisites: ['MAT02'], prerequisiteUnverifiable: false });
  });

  it('pré-requisito que não dá para verificar (carga mínima): BLOCKED, sem inventar o que falta, e avisa', () => {
    expect(find(p.electives, 'ELE03')).toMatchObject({ state: 'BLOCKED', missingPrerequisites: [], prerequisiteUnverifiable: true });
  });

  it('obrigatórios saem em ordem de semestre e depois de código', () => {
    expect(p.required.map((c) => c.code)).toEqual(['FIS01', 'MAT01', 'MAT02', 'PROG1', 'PROG2']);
  });

  it('atrasado: obrigatório de semestre anterior ao atual que ainda falta', () => {
    const late = buildProgress({ ...TRANSCRIPT, currentTerm: 4, entries: [entry('FIS01', 'APR')], pending: [], equivalences: [] }, CURRICULUM);
    expect(late.required.filter((c) => c.late).map((c) => c.code)).toEqual(['MAT01', 'MAT02', 'PROG1', 'PROG2']);
    // sem semestre atual conhecido, nada é "atrasado"
    const unknown = buildProgress({ ...TRANSCRIPT, currentTerm: null, entries: [], pending: [], equivalences: [] }, CURRICULUM);
    expect(unknown.required.some((c) => c.late)).toBe(false);
  });

  it('horas: as feitas vêm do quadro do documento; o que falta é contra o currículo Ativo', () => {
    expect(p.hours.required).toEqual({ needed: 300, completed: 180, remaining: 120, source: 'document' });
    expect(p.hours.elective).toEqual({ needed: 120, completed: 30, remaining: 90, source: 'document' });
    expect(p.hours.complementary).toEqual({ needed: 60, completed: 20, remaining: 40, source: 'document' });
    expect(p.hours.total).toEqual({ needed: 480, completed: 230, remaining: 250, source: 'document' });
    expect(p.percentComplete).toBe(47.9);
  });

  it('sem o quadro do documento, estima pelas horas dos componentes cumpridos', () => {
    const est = buildProgress({ ...TRANSCRIPT, hours: undefined }, CURRICULUM);
    // FIS01 + MAT01 (equiv.) + PROG1 (equiv.) = 180 obrigatórias; ELE02 = 30 optativas
    expect(est.hours.required).toMatchObject({ completed: 180, source: 'estimate' });
    expect(est.hours.elective).toMatchObject({ completed: 30, source: 'estimate' });
    expect(est.hours.total).toMatchObject({ completed: 210, source: 'estimate' });
  });

  it('horas de obrigatórias que ainda falta cursar: exclui cumpridas e matriculadas', () => {
    expect(p.requiredHoursToTake).toBe(60); // só PROG2
  });

  it('o aluno no mesmo currículo do Ativo, ou em outro', () => {
    expect(p.sameCurriculum).toBe(true);
    expect(buildProgress({ ...TRANSCRIPT, curriculumCode: 'G20181 - 2018.1' }, CURRICULUM).sameCurriculum).toBe(false);
    expect(buildProgress({ ...TRANSCRIPT, curriculumCode: undefined }, CURRICULUM).sameCurriculum).toBeNull();
  });

  it('divergências com o histórico: obsoleta pura, substituída, cumprida pela adequação, nova no currículo', () => {
    expect(p.divergences.obsoletePending).toEqual(['OLD77']);
    expect(p.divergences.substitutedPending).toEqual([]);
    // o histórico ainda cobra PROG1 (currículo do aluno), mas a equivalência declarada o cumpre
    expect(p.divergences.satisfiedByAdequation).toEqual(['PROG1']);
    // ENADE é ignorado; MAT02 e PROG2 o histórico também cobra
    expect(p.divergences.newInCurriculum).toEqual([]);
  });

  it('pendente do histórico que o Ativo substitui por outro componente herda o substituto', () => {
    const curriculum: CurriculumInput = { ...CURRICULUM, components: [...CURRICULUM.components, comp('NEW10', { term: 3, equivalenceExpr: '( OLD55 )' })] };
    const t: TranscriptInput = { ...TRANSCRIPT, pending: [...TRANSCRIPT.pending, { code: 'OLD55', name: 'x', hours: 60, enrolled: false }] };
    const r = buildProgress(t, curriculum);
    expect(r.divergences.substitutedPending).toEqual([{ code: 'OLD55', substitutedBy: 'NEW10' }]);
    expect(r.divergences.obsoletePending).toEqual(['OLD77']); // OLD55 deixou de ser obsoleta pura
  });

  it('obrigatório novo no currículo Ativo que o histórico do aluno não cobrava', () => {
    const curriculum: CurriculumInput = { ...CURRICULUM, components: [...CURRICULUM.components, comp('NEW20', { term: 5 })] };
    expect(buildProgress(TRANSCRIPT, curriculum).divergences.newInCurriculum).toEqual(['NEW20']);
  });

  it('uma equivalência cumprida pode satisfazer a de outra componente (até estabilizar)', () => {
    const curriculum: CurriculumInput = {
      ...CURRICULUM,
      components: [comp('AAA1', { equivalenceExpr: '( ZZZ9 )' }), comp('BBB2', { equivalenceExpr: '( AAA1 )' })],
    };
    const r = buildProgress({ ...TRANSCRIPT, entries: [entry('ZZZ9', 'APR')], pending: [], equivalences: [] }, curriculum);
    expect(find(r.required, 'AAA1').state).toBe('DONE_VIA_EQUIVALENCE');
    expect(find(r.required, 'BBB2').state).toBe('DONE_VIA_EQUIVALENCE');
  });

  it('equivalência com E exige todos os códigos', () => {
    const curriculum: CurriculumInput = { ...CURRICULUM, components: [comp('AAA1', { equivalenceExpr: '( OLD1 E OLD2 )' })] };
    const so1 = buildProgress({ ...TRANSCRIPT, entries: [entry('OLD1', 'APR')], pending: [], equivalences: [] }, curriculum);
    expect(find(so1.required, 'AAA1').state).not.toBe('DONE_VIA_EQUIVALENCE');
    const ambos = buildProgress({ ...TRANSCRIPT, entries: [entry('OLD1', 'APR'), entry('OLD2', 'APR')], pending: [], equivalences: [] }, curriculum);
    expect(find(ambos.required, 'AAA1').state).toBe('DONE_VIA_EQUIVALENCE');
  });

  it('reprovado, trancado e cancelado não cumprem; dispensado, cumprido, incorporado e transferido cumprem', () => {
    const r = buildProgress(
      { ...TRANSCRIPT, pending: [], equivalences: [], entries: [entry('FIS01', 'REP'), entry('MAT01', 'TRANC'), entry('MAT02', 'CANC'), entry('PROG1', 'DISP'), entry('PROG2', 'TRANS')] },
      CURRICULUM,
    );
    expect(find(r.required, 'FIS01').state).not.toBe('DONE');
    expect(find(r.required, 'MAT01').state).not.toBe('DONE');
    expect(find(r.required, 'MAT02').state).not.toBe('DONE');
    expect(find(r.required, 'PROG1').state).toBe('DONE');
    expect(find(r.required, 'PROG2').state).toBe('DONE');
  });

  it('é uma estimativa e diz o código do currículo Ativo, os prazos e o semestre atual', () => {
    expect(p).toMatchObject({ estimate: true, curriculumCode: 'G20251', currentTerm: 4, terms: { min: 8, avg: 10, max: 14 } });
  });
});

describe('crossCheckTranscript (conferência com o curso)', () => {
  const entries = [
    entry('FIS01', 'APR'), // existe, horas iguais
    entry('MAT01A', 'APR'), // OB que o Ativo substitui (citado na equivalência de MAT01)
    entry('XYZ99', 'APR'), // OB que não existe em lugar nenhum: obsoleta pura ou leitura errada
    entry('OPT55', 'APR', { nature: 'OP' }), // optativa de outro departamento: não entra
    entry('PROG2', 'APR', { hours: 90 }), // existe, horas diferentes (catálogo diz 60)
  ];
  const check = crossCheckTranscript(entries, CURRICULUM.components);

  it('obrigatório que não está no curso nem em equivalência: unknownRequired', () => {
    expect(check.unknownRequired).toEqual(['XYZ99']);
  });
  it('obrigatório de currículo antigo que o Ativo substitui: esperado, só informativo', () => {
    expect(check.equivalentRequired).toEqual(['MAT01A']);
  });
  it('horas diferentes do catálogo viram aviso com os dois valores', () => {
    expect(check.hourMismatches).toEqual([{ code: 'PROG2', document: 90, catalog: 60 }]);
  });
  it('optativas fora da lista do curso não são suspeitas', () => {
    expect(check.unknownRequired).not.toContain('OPT55');
  });
});

describe('buildProgress: última tentativa e "a refazer"', () => {
  const curriculum: CurriculumInput = {
    ...CURRICULUM,
    components: [comp('AAA1'), comp('BBB2', { prerequisiteExpr: '( AAA1 )' }), comp('CCC3'), comp('DDD4'), comp('EEE5'), comp('FFF6')],
  };
  const build = (entries: TranscriptEntryInput[]) =>
    buildProgress({ ...TRANSCRIPT, entries, pending: [], equivalences: [], hours: undefined, currentTerm: 3 }, curriculum);

  it('reprovada: segue AVAILABLE, mas toRedo, e a tentativa diz semestre, nota e situação', () => {
    const p = build([entry('CCC3', 'REP', { term: '2025.1', grade: 3.5 })]);
    expect(find(p.required, 'CCC3')).toMatchObject({ state: 'AVAILABLE', toRedo: true, lastAttempt: { term: '2025.1', grade: 3.5, status: 'REP' } });
  });

  it('reprovada por falta e trancada também contam como a refazer; cancelada não', () => {
    const p = build([entry('CCC3', 'REPF'), entry('DDD4', 'TRANC', { grade: null }), entry('EEE5', 'CANC', { grade: null })]);
    expect(find(p.required, 'CCC3').toRedo).toBe(true);
    expect(find(p.required, 'DDD4').toRedo).toBe(true);
    expect(find(p.required, 'EEE5')).toMatchObject({ toRedo: false, lastAttempt: { status: 'CANC' } });
  });

  it('reprovada com pré-requisito em falta: BLOCKED e toRedo', () => {
    const p = build([entry('BBB2', 'REP', { grade: 2 })]);
    expect(find(p.required, 'BBB2')).toMatchObject({ state: 'BLOCKED', toRedo: true });
  });

  it('cursada de novo e aprovada: vale a aprovação (DONE), não é a refazer, e a tentativa é a aprovada', () => {
    const p = build([entry('CCC3', 'REP', { term: '2024.1', grade: 3 }), entry('CCC3', 'APR', { term: '2024.2', grade: 7 })]);
    expect(find(p.required, 'CCC3')).toMatchObject({ state: 'DONE', toRedo: false, lastAttempt: { term: '2024.2', grade: 7, status: 'APR' } });
  });

  it('aprovada e depois reprovada de novo (histórico estranho): continua aprovada', () => {
    const p = build([entry('CCC3', 'APR', { term: '2024.1', grade: 7 }), entry('CCC3', 'REP', { term: '2025.1', grade: 2 })]);
    expect(find(p.required, 'CCC3')).toMatchObject({ state: 'DONE', toRedo: false, lastAttempt: { status: 'APR' } });
  });

  it('reprovou e está cursando de novo: ENROLLED, não é a refazer', () => {
    const p = build([entry('CCC3', 'REP', { term: '2025.1', grade: 3 }), entry('CCC3', 'MATR', { term: '2025.2', grade: null })]);
    expect(find(p.required, 'CCC3')).toMatchObject({ state: 'ENROLLED', toRedo: false, lastAttempt: { term: '2025.2', status: 'MATR' } });
  });

  it('entre várias reprovações vale a mais recente; linha sem semestre ("--") dá term nulo', () => {
    const p = build([entry('CCC3', 'REP', { term: '2024.2', grade: 4 }), entry('CCC3', 'REP', { term: '2025.1', grade: 5 }), entry('DDD4', 'DISP', { term: '--', grade: null })]);
    expect(find(p.required, 'CCC3').lastAttempt).toMatchObject({ term: '2025.1', grade: 5 });
    expect(find(p.required, 'DDD4')).toMatchObject({ state: 'DONE', lastAttempt: { term: null, status: 'DISP' } });
  });

  it('nunca cursado: lastAttempt nulo e toRedo falso', () => {
    expect(find(build([]).required, 'FFF6')).toMatchObject({ lastAttempt: null, toRedo: false });
  });
});
