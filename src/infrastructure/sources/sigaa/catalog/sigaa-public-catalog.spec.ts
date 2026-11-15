import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoActiveCurriculumError } from '../../../../application/academic/catalog.service';
import type { SigaaHttpClient, SigaaHttpRequest } from '../http-client';
import { SigaaPublicCatalogSource, throttled } from './sigaa-public-catalog';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
const ok = (body: string, headers: Record<string, string> = {}) => ({ status: 200, headers: { 'set-cookie': '', location: '', 'content-type': 'text/html', ...headers }, body });

/** SIGAA falso: serve as páginas públicas reais e guarda tudo o que foi pedido. */
function fakeSigaa(opts: { semAtiva?: boolean } = {}) {
  const requests: SigaaHttpRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const http: SigaaHttpClient = {
    async request(req) {
      requests.push(req);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (req.method === 'GET' && req.path.startsWith('/sigaa/public/curso/lista.jsf')) return ok(fixture('curso-lista.html'));
      if (req.method === 'GET' && req.path.startsWith('/sigaa/public/curso/curriculo.jsf')) {
        const html = fixture('curso-estruturas.html');
        return ok(opts.semAtiva ? html.replace(/>(\s*)Ativa(\s*)</g, '>$1Inativa$2<') : html, { 'set-cookie': 'JSESSIONID=anon; Path=/' });
      }
      if (req.method === 'POST' && req.path === '/sigaa/public/curso/curriculo.jsf') return ok(fixture('estrutura-resumo.html'));
      if (req.method === 'POST' && req.path === '/sigaa/public/curso/resumo_curriculo.jsf') {
        // Só dois componentes têm página de detalhe de fixture; os outros recebem a página de OUTRO componente.
        if (req.body?.id === '30548') return ok(fixture('componente-resumo-com-prerequisito.html'));
        return ok(fixture('componente-resumo-sem-prerequisito.html'));
      }
      return { status: 404, headers: {}, body: '' };
    },
  };
  return { http, requests, maxInFlight: () => maxInFlight };
}

describe('SigaaPublicCatalogSource', () => {
  it('listPrograms lê a lista pública de cursos', async () => {
    const { http } = fakeSigaa();
    const programs = await new SigaaPublicCatalogSource(http, 0).listPrograms();
    expect(programs.find((p) => p.sigaaId === '1876880')).toMatchObject({ name: 'ENGENHARIA DA COMPUTAÇÃO', campus: 'SALVADOR', level: 'G' });
  });

  it('activeCurriculumCode é a checagem barata: uma página só, devolve o código da Ativa', async () => {
    const { http, requests } = fakeSigaa();
    await expect(new SigaaPublicCatalogSource(http, 0).activeCurriculumCode('1876880')).resolves.toBe('G20251');
    expect(requests).toHaveLength(1);
  });

  it('sem estrutura Ativa: NoActiveCurriculumError', async () => {
    const { http } = fakeSigaa({ semAtiva: true });
    await expect(new SigaaPublicCatalogSource(http, 0).activeCurriculumCode('1876880')).rejects.toBeInstanceOf(NoActiveCurriculumError);
    await expect(new SigaaPublicCatalogSource(http, 0).fetchActiveCurriculum('1876880')).rejects.toBeInstanceOf(NoActiveCurriculumError);
  });

  // Uma importação só para as asserções abaixo: cada componente é uma página de ~40 KB para o cheerio, então é lenta.
  describe('fetchActiveCurriculum (estrutura Ativa inteira)', () => {
    let data: Awaited<ReturnType<SigaaPublicCatalogSource['fetchActiveCurriculum']>>;
    let requests: SigaaHttpRequest[];
    let maxInFlight: () => number;

    beforeAll(async () => {
      const sigaa = fakeSigaa();
      requests = sigaa.requests;
      maxInFlight = sigaa.maxInFlight;
      data = await new SigaaPublicCatalogSource(sigaa.http, 0).fetchActiveCurriculum('1876880');
    }, 120_000);

    it('traz a estrutura Ativa com os números e os componentes', () => {
      expect(data).toMatchObject({ code: 'G20251', implementationTerm: '2025.2', totalHours: 3610, requiredHours: 3150, minElectiveHours: 360, minComplementaryHours: 100, minTerms: 12, avgTerms: 12, maxTerms: 18 });
      expect(data.sigaaId).toMatch(/^\d+$/);
      expect(data.components.length).toBeGreaterThan(30);
    });

    it('lê o detalhe de um componente: pré-requisito, equivalências e unidade', () => {
      const eng295 = data.components.find((c) => c.code === 'ENG295')!;
      expect(eng295).toMatchObject({ nature: 'ELECTIVE', term: null, hours: 60 });
      expect(eng295.prerequisiteExpr).toBe('( FISD36 E FISD42 E QUI037 ) OU ( ENGJ18 ) OU ( FISD34 E ( QUIA27 OU ( FISD41 E QUI029 ) ) )');
      expect(eng295.equivalenceExpr).toBe('( ENG295A ) OU ( ENG295B ) OU ( ENG295C )');
      expect(eng295.responsibleUnit).toContain('ENGENHARIA AMBIENTAL');
    });

    it('um detalhe que volta descrevendo OUTRO componente vira ausência, nunca o pré-requisito do outro', () => {
      const other = data.components.find((c) => c.code !== 'ENG295' && c.code !== 'FISD36')!;
      expect(other).toMatchObject({ prerequisiteExpr: null, corequisiteExpr: null, equivalenceExpr: null, responsibleUnit: null });
    });

    it('o POST da matriz leva os campos do formulário, os parâmetros do jsfcljs e o ViewState', () => {
      const matrix = requests.find((r) => r.method === 'POST' && r.path === '/sigaa/public/curso/curriculo.jsf')!;
      expect(matrix.body).toMatchObject({ formCurriculosCurso: 'formCurriculosCurso', nivel: 'G' });
      expect(matrix.body?.id).toMatch(/^\d+$/);
      expect(matrix.body?.['javax.faces.ViewState']).toBeTruthy();
    });

    it('os detalhes vão em sequência (nunca dois ao mesmo tempo): a página guarda o componente na sessão', () => {
      expect(maxInFlight()).toBe(1);
    });

    it('um detalhe que volta trocado é tentado de novo uma vez antes de ser descartado', () => {
      const details = requests.filter((r) => r.path === '/sigaa/public/curso/resumo_curriculo.jsf');
      // Cada componente sem fixture própria pede duas vezes; ENG295 e FISD36 acertam de primeira.
      expect(details.length).toBeGreaterThan(data.components.length);
    });
  });
});

describe('throttled', () => {
  it('espaça as requisições pelo intervalo mínimo', async () => {
    const waits: number[] = [];
    let now = 1_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const http = throttled({ request: async () => ok('') }, 350, async (ms) => void (waits.push(ms), (now += ms)));
    await http.request({ method: 'GET', path: '/a' });
    await http.request({ method: 'GET', path: '/b' });
    await http.request({ method: 'GET', path: '/c' });
    spy.mockRestore();
    expect(waits).toEqual([350, 350]);
  });
});
