import { Logger } from '@nestjs/common';
import {
  CatalogSource,
  type ActiveCurriculumData,
  type CatalogComponent,
  type CatalogProgram,
} from '../../../../application/ports/catalog';
import { NoActiveCurriculumError } from '../../../../application/academic/catalog.service';
import { createSigaaHttpClient, type SigaaHttpClient } from '../http-client';
import { parseComponentDetail } from './component-detail';
import { parseCurriculumList } from './curriculum-list';
import { parseCurriculumSummary, type SummaryComponent } from './curriculum-summary';
import { PublicCurriculumSession } from './public-session';
import { parseProgramList } from './program-list';

const LIST_PATH = '/sigaa/public/curso/lista.jsf';
const CURRICULUM_PATH = '/sigaa/public/curso/curriculo.jsf';
const SUMMARY_PATH = '/sigaa/public/curso/resumo_curriculo.jsf';
/** Intervalo mínimo entre requisições às páginas públicas (o projeto de referência mede que 0,25 s é pouco). */
export const MIN_INTERVAL_MS = 350;
/** Uma nova tentativa para um detalhe que volta descrevendo outro componente. */
const DETAIL_ATTEMPTS = 2;

/** Espaça as requisições: o SIGAA público tem regra de intervalo mínimo e não é para martelar. */
export function throttled(http: SigaaHttpClient, minIntervalMs: number, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): SigaaHttpClient {
  let last = 0;
  return {
    async request(req) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return http.request(req);
    },
  };
}

/**
 * Catálogo do SIGAA pelas páginas públicas (sem login e sem senha de ninguém). Port dos parsers e do `resolverCurso` do
 * app antigo, com as mesmas lições: os detalhes de componente vão **em sequência** (a página guarda o componente na
 * sessão e POSTs sobrepostos voltam trocados), e um detalhe que descreve outro componente vira ausência, nunca um
 * pré-requisito errado.
 */
export class SigaaPublicCatalogSource extends CatalogSource {
  private readonly log = new Logger('SigaaPublicCatalog');
  private readonly http: SigaaHttpClient;

  constructor(http: SigaaHttpClient = createSigaaHttpClient(), minIntervalMs: number = MIN_INTERVAL_MS) {
    super();
    this.http = throttled(http, minIntervalMs);
  }

  async listPrograms(): Promise<CatalogProgram[]> {
    const response = await this.http.request({ method: 'GET', path: LIST_PATH });
    if (response.status !== 200) throw new Error(`lista de cursos do SIGAA → ${response.status}`);
    return parseProgramList(response.body);
  }

  async activeCurriculumCode(programId: string): Promise<string> {
    const session = new PublicCurriculumSession(this.http);
    const html = await session.open(`${CURRICULUM_PATH}?lc=pt_BR&id=${encodeURIComponent(programId)}`);
    const active = parseCurriculumList(html).find((c) => c.active);
    if (!active) throw new NoActiveCurriculumError();
    return active.code;
  }

  async fetchActiveCurriculum(programId: string): Promise<ActiveCurriculumData> {
    const session = new PublicCurriculumSession(this.http);
    const listHtml = await session.open(`${CURRICULUM_PATH}?lc=pt_BR&id=${encodeURIComponent(programId)}`);
    const active = parseCurriculumList(listHtml).find((c) => c.active);
    if (!active) throw new NoActiveCurriculumError();

    // Um navegador também envia os campos ocultos do formulário que envolve o link; sem o marcador do formulário o JSF
    // não sabe que ele foi enviado e a ação não dispara.
    const summaryHtml = await session.post(CURRICULUM_PATH, { ...active.formFields, ...active.jsfParams });
    const summary = parseCurriculumSummary(summaryHtml);

    // Em sequência, de propósito (ver a doc da classe).
    const components: CatalogComponent[] = [];
    for (const component of summary.components) {
      components.push(await this.detail(session, summary.formFields, component));
    }

    return {
      sigaaId: active.jsfParams.id,
      code: active.code,
      implementationTerm: summary.implementationTerm,
      totalHours: summary.totalHours,
      requiredHours: summary.requiredHours,
      minElectiveHours: summary.minElectiveHours,
      minComplementaryHours: summary.minComplementaryHours,
      minTerms: summary.minTerms,
      avgTerms: summary.avgTerms,
      maxTerms: summary.maxTerms,
      components,
    };
  }

  /** O componente com o detalhe, ou o mesmo componente com os campos de detalhe nulos se não deu para ler de verdade. */
  private async detail(session: PublicCurriculumSession, formFields: Record<string, string>, component: SummaryComponent): Promise<CatalogComponent> {
    const { jsfParams, ...base } = component;
    const without: CatalogComponent = {
      ...base,
      responsibleUnit: null,
      prerequisiteExpr: null,
      corequisiteExpr: null,
      equivalenceExpr: null,
    };

    for (let attempt = 1; attempt <= DETAIL_ATTEMPTS; attempt++) {
      let html: string;
      try {
        // A página de detalhe não traz ViewState nem avança a conversa JSF: não substitui o ViewState da matriz.
        html = await session.post(SUMMARY_PATH, { ...formFields, ...jsfParams }, { captureViewState: false });
      } catch (error) {
        this.log.warn(`falha ao buscar o detalhe do componente ${component.code}: ${error instanceof Error ? error.message : 'erro'}`);
        return without;
      }
      // Só a chamada de rede é capturada: exceção do parser é bug, não falha transitória do componente.
      const page = parseComponentDetail(html);
      if (page.code === null || page.code === component.code) {
        return {
          ...base,
          responsibleUnit: page.responsibleUnit,
          prerequisiteExpr: page.prerequisite,
          corequisiteExpr: page.corequisite,
          equivalenceExpr: page.equivalences,
        };
      }
      this.log.warn(`o detalhe pedido para ${component.code} voltou descrevendo ${page.code} (tentativa ${attempt}/${DETAIL_ATTEMPTS})`);
    }
    this.log.error(`descartando o detalhe de ${component.code}: nenhuma tentativa devolveu a página dele`);
    return without;
  }
}
