import { FakeCatalogSource, InMemoryCatalog } from '../../../test/support/catalog-fake';
import { CATALOG_TTL_MS, CatalogService, ProgramNotFoundError, splitProgramName } from './catalog.service';

const DAY = 24 * 60 * 60 * 1000;
const PROGRAMS = [
  { sigaaId: '10', name: 'ENGENHARIA DA COMPUTAÇÃO', campus: 'SALVADOR', level: 'G' },
  { sigaaId: '11', name: 'ENGENHARIA DA COMPUTAÇÃO', campus: 'VITÓRIA DA CONQUISTA', level: 'G' },
  { sigaaId: '12', name: 'ADMINISTRAÇÃO', campus: 'SALVADOR', level: 'G' },
  { sigaaId: '13', name: 'ADMINISTRAÇÃO', campus: 'SALVADOR', level: 'S' }, // pós: não entra
];

function montar() {
  let t = new Date('2026-11-15T12:00:00Z').getTime();
  const repo = new InMemoryCatalog();
  const source = new FakeCatalogSource();
  source.programs = PROGRAMS;
  const svc = new CatalogService(repo, source, () => new Date(t));
  return { repo, source, svc, avancar: (ms: number) => (t += ms) };
}

describe('splitProgramName', () => {
  it('separa nome e campus do jeito que o portal escreve', () => {
    expect(splitProgramName('ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador')).toEqual({ name: 'ENGENHARIA DE COMPUTAÇÃO', campus: 'Salvador' });
    expect(splitProgramName('ADMINISTRAÇÃO')).toEqual({ name: 'ADMINISTRAÇÃO', campus: undefined });
  });
});

describe('CatalogService.findProgram', () => {
  it('ignora "DE/DA/DO" na comparação e usa o campus para desempatar', async () => {
    const { svc } = montar();
    expect((await svc.findProgram('ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador')).sigaaId).toBe('10');
    expect((await svc.findProgram('ENGENHARIA DE COMPUTAÇÃO/UESB - Vitória da Conquista')).sigaaId).toBe('11');
  });

  it('só considera graduação', async () => {
    const { svc } = montar();
    expect((await svc.findProgram('ADMINISTRAÇÃO')).sigaaId).toBe('12');
  });

  it('sem campus e com mais de um candidato, ou sem candidato: ProgramNotFoundError', async () => {
    const { svc } = montar();
    await expect(svc.findProgram('ENGENHARIA DA COMPUTAÇÃO')).rejects.toBeInstanceOf(ProgramNotFoundError);
    await expect(svc.findProgram('CURSO QUE NÃO EXISTE')).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it('a lista de cursos vem do SIGAA uma vez e fica no banco por 30 dias', async () => {
    const { svc, source, avancar } = montar();
    await svc.findProgram('ADMINISTRAÇÃO');
    await svc.findProgram('ADMINISTRAÇÃO');
    expect(source.calls.list).toBe(1);
    avancar(CATALOG_TTL_MS + DAY);
    await svc.findProgram('ADMINISTRAÇÃO');
    expect(source.calls.list).toBe(2);
  });
});

describe('CatalogService.ensureCurriculum', () => {
  it('primeira vez: importa o currículo Ativo e grava; depois reaproveita sem tocar no SIGAA', async () => {
    const { svc, source, repo } = montar();
    const a = await svc.ensureCurriculum('10');
    expect(a.curriculum.code).toBe('G20251');
    expect(a.program.name).toBe('ENGENHARIA DA COMPUTAÇÃO');
    expect(source.calls.fetch).toBe(1);
    expect((await repo.findComponents('10')).map((c) => c.code)).toEqual(['FISD36']);

    await svc.ensureCurriculum('10');
    expect(source.calls).toMatchObject({ fetch: 1, code: 0 });
  });

  it('alunos do mesmo curso ao mesmo tempo: uma importação só', async () => {
    const { svc, source } = montar();
    source.delayMs = 30;
    const [a, b, c] = await Promise.all([svc.ensureCurriculum('10'), svc.ensureCurriculum('10'), svc.ensureCurriculum('10')]);
    expect(source.calls.fetch).toBe(1);
    expect([a.curriculum.code, b.curriculum.code, c.curriculum.code]).toEqual(['G20251', 'G20251', 'G20251']);
  });

  it('cursos diferentes não se esperam', async () => {
    const { svc, source } = montar();
    await Promise.all([svc.ensureCurriculum('10'), svc.ensureCurriculum('12')]);
    expect(source.calls.fetch).toBe(2);
  });

  it('mais de 30 dias e o Ativo é o mesmo: só a checagem barata, renova a data, sem refazer a estrutura', async () => {
    const { svc, source, repo, avancar } = montar();
    await svc.ensureCurriculum('10');
    avancar(CATALOG_TTL_MS + DAY);
    const again = await svc.ensureCurriculum('10');
    expect(source.calls).toMatchObject({ fetch: 1, code: 1 });
    expect(again.curriculum.fetchedAt.getTime()).toBeGreaterThan(Date.parse('2026-11-15T12:00:00Z') + CATALOG_TTL_MS);
    expect((await repo.findCurriculum('10'))!.fetchedAt).toEqual(again.curriculum.fetchedAt);
  });

  it('mais de 30 dias e o Ativo mudou: refaz a estrutura e troca o currículo guardado', async () => {
    const { svc, source, repo, avancar } = montar();
    await svc.ensureCurriculum('10');
    avancar(CATALOG_TTL_MS + DAY);
    source.activeCode = 'G20271';
    const novo = await svc.ensureCurriculum('10');
    expect(source.calls).toMatchObject({ fetch: 2, code: 1 });
    expect(novo.curriculum.code).toBe('G20271');
    expect((await repo.findCurriculum('10'))!.code).toBe('G20271');
  });

  it('curso desconhecido: ProgramNotFoundError, sem importar nada', async () => {
    const { svc, source } = montar();
    await expect(svc.ensureCurriculum('999')).rejects.toBeInstanceOf(ProgramNotFoundError);
    expect(source.calls.fetch).toBe(0);
  });

  it('uma importação que falha não trava as próximas', async () => {
    const { svc, source } = montar();
    const original = source.fetchActiveCurriculum.bind(source);
    source.fetchActiveCurriculum = async () => {
      throw new Error('SIGAA fora');
    };
    await expect(svc.ensureCurriculum('10')).rejects.toThrow('SIGAA fora');
    source.fetchActiveCurriculum = original;
    await expect(svc.ensureCurriculum('10')).resolves.toBeDefined();
  });

  it('read devolve o que está guardado sem tocar no SIGAA', async () => {
    const { svc, source } = montar();
    await expect(svc.read('10')).resolves.toBeNull();
    await svc.ensureCurriculum('10');
    const before = { ...source.calls };
    const r = await svc.read('10');
    expect(r?.curriculum.code).toBe('G20251');
    expect(r?.components).toHaveLength(1);
    expect(source.calls).toEqual(before);
  });

  it('readView: o currículo com o grafo, em cache; a importação nova invalida o cache na hora, sem esperar o prazo', async () => {
    const { svc, source, repo } = montar();
    await expect(svc.readView('10')).resolves.toBeNull();
    await svc.ensureCurriculum('10');
    const first = await svc.readView('10');
    expect(first?.curriculum.code).toBe('G20251');
    expect(first?.graph.components.has('FISD36')).toBe(true);
    expect(await svc.readView('10')).toBe(first);

    // o currículo guardado envelheceu e o Ativo mudou; o relógio não andou, então o cache ainda estaria no prazo
    await repo.touchCurriculum('10', new Date(0));
    source.activeCode = 'G20271';
    await svc.ensureCurriculum('10');
    const nova = await svc.readView('10');
    expect(nova).not.toBe(first);
    expect(nova?.curriculum.code).toBe('G20271');
  });
});
