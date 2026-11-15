import { labelShape, parseProgramLabel, titleCase } from './program-label';

const REAL = 'ENGENHARIA DA COMPUTAÇÃO/EPOLI - SALVADOR - BACHARELADO - PRESENCIAL - N';

describe('parseProgramLabel', () => {
  it('formato completo (texto real do histórico): título e os quatro pedaços', () => {
    expect(parseProgramLabel(REAL)).toEqual({
      raw: REAL,
      name: 'Engenharia da Computação',
      unit: 'EPOLI',
      campus: 'Salvador',
      degree: 'Bacharelado',
      modality: 'Presencial',
      shift: 'Noturno',
      format: 'full',
    });
  });

  it('o texto original vai sempre junto, intacto', () => {
    for (const raw of [REAL, 'x', '', '  ', 'A - B', ' - ', 'MATEMÁTICA/IME - SALVADOR - LICENCIATURA - PRESENCIAL - M']) expect(parseProgramLabel(raw).raw).toBe(raw);
  });

  it.each([
    ['MATEMÁTICA/IME - SALVADOR - LICENCIATURA - PRESENCIAL - M', 'Matemática', 'Licenciatura', 'Matutino'],
    ['QUÍMICA/IQ - SALVADOR - BACHARELADO - PRESENCIAL - T', 'Química', 'Bacharelado', 'Vespertino'],
    ['MEDICINA/FMB - SALVADOR - BACHARELADO - PRESENCIAL - I', 'Medicina', 'Bacharelado', 'Integral'],
  ])('%s', (raw, name, degree, shift) => {
    expect(parseProgramLabel(raw)).toMatchObject({ name, degree, shift, format: 'full' });
  });

  it('campus com várias palavras e preposição', () => {
    expect(parseProgramLabel('AGRONOMIA/IMS - VITÓRIA DA CONQUISTA - BACHARELADO - PRESENCIAL - I').campus).toBe('Vitória da Conquista');
  });

  it('menos pedaços: só o que existe, sem inventar o resto (degrau 2)', () => {
    expect(parseProgramLabel('ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador')).toEqual({
      raw: 'ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador',
      name: 'Engenharia de Computação',
      unit: 'PGCOMP',
      campus: 'Salvador',
      degree: null,
      modality: null,
      shift: null,
      format: 'partial',
    });
    expect(parseProgramLabel('DANÇA - SALVADOR - LICENCIATURA')).toMatchObject({ name: 'Dança', unit: null, campus: 'Salvador', degree: 'Licenciatura', modality: null, shift: null, format: 'partial' });
    expect(parseProgramLabel('ADMINISTRAÇÃO')).toMatchObject({ name: 'Administração', unit: null, campus: null, format: 'partial' });
  });

  it('valor desconhecido aparece como veio, sem traduzir (degrau 3)', () => {
    const l = parseProgramLabel('CURSO NOVO/ESC - SALVADOR - GRAU INVENTADO - HÍBRIDO - D');
    expect(l).toMatchObject({ name: 'Curso Novo', degree: 'Grau Inventado', modality: 'Híbrido', shift: 'D', format: 'full' });
    expect(parseProgramLabel('X/Y - Z - BACHARELADO - PRESENCIAL - NOTURNO').shift).toBe('Noturno');
  });

  it('modalidade a distância', () => {
    expect(parseProgramLabel('PEDAGOGIA/FACED - SALVADOR - LICENCIATURA - A DISTÂNCIA - N').modality).toBe('A distância');
  });

  it('nome com " - " dentro: vale se os quatro últimos parecem campus/grau/modalidade/turno', () => {
    const raw = 'LETRAS - LÍNGUA ESTRANGEIRA/IL - SALVADOR - LICENCIATURA - PRESENCIAL - N';
    expect(parseProgramLabel(raw)).toMatchObject({ name: 'Letras - Língua Estrangeira', unit: 'IL', campus: 'Salvador', degree: 'Licenciatura', format: 'full' });
  });

  it('muitos pedaços sem sentido: cai no texto original (degrau 4)', () => {
    const raw = 'A - B - C - D - E - F';
    expect(parseProgramLabel(raw)).toMatchObject({ name: raw, format: 'raw', unit: null, campus: null, degree: null });
  });

  it('vazio, só espaço ou sem nome: texto original, formato raw', () => {
    for (const raw of ['', '   ', ' - SALVADOR', '/EPOLI - SALVADOR']) expect(parseProgramLabel(raw)).toMatchObject({ name: raw, format: 'raw' });
  });

  it('nunca lança, mesmo com entrada que não é texto', () => {
    expect(() => parseProgramLabel(undefined as unknown as string)).not.toThrow();
    expect(parseProgramLabel(null as unknown as string)).toMatchObject({ raw: '', format: 'raw' });
  });

  it('separador final solto não cria pedaço vazio', () => {
    expect(parseProgramLabel('DESIGN/EBA - SALVADOR - BACHARELADO - PRESENCIAL - D - ')).toMatchObject({ name: 'Design', format: 'full', shift: 'D' });
  });
});

describe('titleCase', () => {
  it.each([
    ['ENGENHARIA DE CONTROLE E AUTOMAÇÃO DE PROCESSOS', 'Engenharia de Controle e Automação de Processos'],
    ['LETRAS VERNÁCULAS', 'Letras Vernáculas'],
    ['ARTES VISUAIS II', 'Artes Visuais II'],
    ['ENGENHARIA DE AGRIMENSURA E CARTOGRÁFICA', 'Engenharia de Agrimensura e Cartográfica'],
    ['CIÊNCIA DA COMPUTAÇÃO', 'Ciência da Computação'],
    ['DA VINCI', 'Da Vinci'],
  ])('%s → %s', (a, b) => expect(titleCase(a)).toBe(b));
});

describe('labelShape (só formato, nunca texto)', () => {
  it('o padrão completo conhecido não conta como fora do padrão', () => {
    expect(labelShape(REAL, parseProgramLabel(REAL))).toBe('full:5p');
  });
  it('descreve o degrau, o número de pedaços e o que é desconhecido, sem o texto do curso', () => {
    const raw = 'CURSO SECRETO/ESC - SALVADOR - GRAU RARO - PRESENCIAL - D';
    const shape = labelShape(raw, parseProgramLabel(raw));
    expect(shape).toBe('full:5p:desconhecido=grau+turno');
    expect(shape).not.toMatch(/SECRETO|Secreto|RARO|Raro/);
    expect(labelShape('A - B', parseProgramLabel('A - B'))).toBe('partial:2p');
    expect(labelShape('', parseProgramLabel(''))).toBe('raw');
  });
});
