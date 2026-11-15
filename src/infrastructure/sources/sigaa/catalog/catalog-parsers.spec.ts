import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseComponentDetail } from './component-detail';
import { parseCurriculumList } from './curriculum-list';
import { parseCurriculumSummary } from './curriculum-summary';
import { parseProgramList } from './program-list';

// Páginas públicas reais do SIGAA (sem dado de ninguém; o JSESSIONID anônimo foi trocado por FIXTURE).
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');

describe('parseProgramList', () => {
  const programs = parseProgramList(fixture('curso-lista.html'));

  it('extrai id, nome, campus e nível de cada curso', () => {
    expect(programs.find((p) => p.name === 'ENGENHARIA DA COMPUTAÇÃO' && p.level === 'G')).toEqual({
      sigaaId: '1876880',
      name: 'ENGENHARIA DA COMPUTAÇÃO',
      campus: 'SALVADOR',
      level: 'G',
    });
  });

  it('pula as linhas de unidade, que não têm link de curso', () => {
    expect(programs.some((p) => p.name.includes('ESCOLA POLITÉCNICA'))).toBe(false);
  });

  it('lê vários cursos', () => {
    expect(programs.length).toBeGreaterThan(50);
  });
});

describe('parseCurriculumList', () => {
  const curricula = parseCurriculumList(fixture('curso-estruturas.html'));

  it('lista cada estrutura com código e situação', () => {
    expect(curricula.map((c) => c.code)).toEqual(expect.arrayContaining(['G20251', 'T20252', '186140']));
  });

  it('identifica exatamente uma estrutura como ativa', () => {
    expect(curricula.filter((c) => c.active)).toHaveLength(1);
    expect(curricula.find((c) => c.active)?.code).toBe('G20251');
  });

  it('guarda os parâmetros do jsfcljs para chegar à matriz dela', () => {
    const active = curricula.find((c) => c.active);
    expect(active?.jsfParams.id).toMatch(/^\d+$/);
    expect(Object.keys(active!.jsfParams).length).toBeGreaterThanOrEqual(2);
  });

  it('guarda os campos ocultos do formulário, sem o ViewState', () => {
    expect(curricula.find((c) => c.active)?.formFields).toEqual({ formCurriculosCurso: 'formCurriculosCurso', nivel: 'G' });
  });
});

describe('parseCurriculumSummary', () => {
  const summary = parseCurriculumSummary(fixture('estrutura-resumo.html'));

  it('extrai a vigência e as cargas horárias', () => {
    expect(summary.implementationTerm).toBe('2025.2');
    expect(summary.totalHours).toBe(3610);
    expect(summary.requiredHours).toBe(3150);
    expect(summary.minElectiveHours).toBe(360);
    expect(summary.minComplementaryHours).toBe(100);
  });

  it('extrai o prazo de conclusão em semestres', () => {
    expect(summary.minTerms).toBe(12);
    expect(summary.avgTerms).toBe(12);
    expect(summary.maxTerms).toBe(18);
  });

  it('lê um componente obrigatório com semestre e id do SIGAA', () => {
    expect(summary.components.find((c) => c.code === 'FISD36')).toEqual({
      sigaaId: '34997',
      code: 'FISD36',
      name: 'FÍSICA GERAL TEÓRICA I',
      hours: 60,
      nature: 'REQUIRED',
      term: 1,
      jsfParams: { 'formulario:j_id_jsp_337523315_66': 'formulario:j_id_jsp_337523315_66', id: '34997', publico: 'public' },
    });
  });

  it('lê uma optativa com semestre nulo', () => {
    expect(summary.components.find((c) => c.code === 'ENG295')).toEqual({
      sigaaId: '30548',
      code: 'ENG295',
      name: 'HIGIENE E SEGURANÇA NO TRABALHO',
      hours: 60,
      nature: 'ELECTIVE',
      term: null,
      jsfParams: { 'formulario:j_id_jsp_337523315_46': 'formulario:j_id_jsp_337523315_46', id: '30548', publico: 'public' },
    });
  });

  it('guarda os campos ocultos do #formulario, sem o ViewState', () => {
    expect(summary.formFields).toEqual({ formulario: 'formulario' });
  });
});

describe('parseComponentDetail', () => {
  it('extrai unidade, pré-requisito, co-requisito e equivalências como texto cru', () => {
    const d = parseComponentDetail(fixture('componente-resumo-com-prerequisito.html'));
    expect(d.responsibleUnit).toBe('DEPARTAMENTO DE ENGENHARIA AMBIENTAL/POLI - SALVADOR - 12.01.23.05');
    expect(d.prerequisite).toBe('( FISD36 E FISD42 E QUI037 ) OU ( ENGJ18 ) OU ( FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) ) )');
    expect(d.corequisite).toBeNull();
    expect(d.equivalences).toBe('( ENG295A ) OU ( ENG295B ) OU ( ENG295C )');
  });

  it('lê o "-" do SIGAA como nulo, não como o texto "-"; os campos são independentes', () => {
    const d = parseComponentDetail(fixture('componente-resumo-sem-prerequisito.html'));
    expect(d.prerequisite).toBeNull();
    expect(d.corequisite).toBeNull();
    expect(d.equivalences).not.toBeNull();
  });

  it('devolve o código que a própria página descreve (para pegar resposta de outro componente)', () => {
    expect(parseComponentDetail(fixture('componente-resumo-com-prerequisito.html')).code).toBe('ENG295');
    expect(parseComponentDetail(fixture('componente-resumo-sem-prerequisito.html')).code).toBe('FISD36');
  });
});
