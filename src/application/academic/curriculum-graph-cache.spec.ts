import { InMemoryCatalog, sampleCurriculum } from '../../../test/support/catalog-fake';
import { CurriculumGraphCache, GRAPH_CACHE_TTL_MS } from './curriculum-graph-cache';

/** Catálogo que conta as leituras, para provar que o cache poupa o banco. */
class CountingCatalog extends InMemoryCatalog {
  reads = { curriculum: 0, components: 0 };
  async findCurriculum(programId: string) {
    this.reads.curriculum++;
    return super.findCurriculum(programId);
  }
  async findComponents(programId: string) {
    this.reads.components++;
    return super.findComponents(programId);
  }
}

const AT = new Date('2026-11-15T12:00:00Z');

async function montar() {
  let t = AT.getTime();
  const repo = new CountingCatalog();
  await repo.replaceCurriculum('10', sampleCurriculum('G20251', '9001'), AT);
  const cache = new CurriculumGraphCache(repo, () => new Date(t));
  return { repo, cache, avancar: (ms: number) => (t += ms) };
}

describe('CurriculumGraphCache', () => {
  it('curso sem currículo importado: null, sem montar nada', async () => {
    const { cache, repo } = await montar();
    expect(await cache.forProgram('99')).toBeNull();
    expect(repo.reads.components).toBe(0);
  });

  it('a primeira leitura monta; dentro do prazo não toca mais no banco', async () => {
    const { cache, repo, avancar } = await montar();
    const first = await cache.forProgram('10');
    expect(first?.components.has('FISD36')).toBe(true);
    expect(repo.reads).toEqual({ curriculum: 1, components: 1 });

    avancar(GRAPH_CACHE_TTL_MS - 1);
    expect(await cache.forProgram('10')).toBe(first);
    expect(repo.reads).toEqual({ curriculum: 1, components: 1 });
  });

  it('passado o prazo com a mesma versão: confere a linha do currículo, não remonta e renova o prazo', async () => {
    const { cache, repo, avancar } = await montar();
    const first = await cache.forProgram('10');
    avancar(GRAPH_CACHE_TTL_MS + 1);
    expect(await cache.forProgram('10')).toBe(first);
    expect(repo.reads).toEqual({ curriculum: 2, components: 1 });

    avancar(GRAPH_CACHE_TTL_MS - 1); // o prazo recomeçou na conferência
    await cache.forProgram('10');
    expect(repo.reads.curriculum).toBe(2);
  });

  it('a importação gravou outro currículo: passado o prazo, remonta', async () => {
    const { cache, repo, avancar } = await montar();
    const first = await cache.forProgram('10');
    const next = sampleCurriculum('G20261', '9002');
    next.components = [{ ...next.components[0], code: 'NEW10', equivalenceExpr: null }];
    await repo.replaceCurriculum('10', next, new Date(AT.getTime() + 1000));

    avancar(GRAPH_CACHE_TTL_MS + 1);
    const second = await cache.forProgram('10');
    expect(second).not.toBe(first);
    expect(second?.components.has('NEW10')).toBe(true);
    expect(second?.components.has('FISD36')).toBe(false);
  });

  it('o mesmo currículo com `fetchedAt` renovado também remonta (a versão inclui o fetchedAt)', async () => {
    const { cache, repo, avancar } = await montar();
    const first = await cache.forProgram('10');
    await repo.touchCurriculum('10', new Date(AT.getTime() + 1000));
    avancar(GRAPH_CACHE_TTL_MS + 1);
    expect(await cache.forProgram('10')).not.toBe(first);
  });

  it('`invalidate` força remontar já na próxima leitura', async () => {
    const { cache, repo } = await montar();
    const first = await cache.forProgram('10');
    cache.invalidate('10');
    expect(await cache.forProgram('10')).not.toBe(first);
    expect(repo.reads.components).toBe(2);
    cache.invalidate();
    await cache.forProgram('10');
    expect(repo.reads.components).toBe(3);
  });

  it('leituras simultâneas do mesmo curso viram uma montagem só', async () => {
    const { cache, repo } = await montar();
    const [a, b, c] = await Promise.all([cache.forProgram('10'), cache.forProgram('10'), cache.forProgram('10')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(repo.reads).toEqual({ curriculum: 1, components: 1 });
  });

  it('erro do banco não fica guardado: a leitura seguinte tenta de novo', async () => {
    const { cache, repo } = await montar();
    const original = repo.findComponents.bind(repo);
    let falhar = true;
    repo.findComponents = async (id: string) => {
      if (falhar) throw new Error('banco fora');
      return original(id);
    };
    await expect(cache.forProgram('10')).rejects.toThrow('banco fora');
    falhar = false;
    expect((await cache.forProgram('10'))?.components.has('FISD36')).toBe(true);
  });

  it('cursos diferentes não se misturam', async () => {
    const { cache, repo } = await montar();
    const other = sampleCurriculum('G20251', '9100');
    other.components = [{ ...other.components[0], code: 'OUT01' }];
    await repo.replaceCurriculum('11', other, AT);
    expect((await cache.forProgram('10'))?.components.has('OUT01')).toBe(false);
    expect((await cache.forProgram('11'))?.components.has('OUT01')).toBe(true);
  });
});
