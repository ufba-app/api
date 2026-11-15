import type { SigaaHttpClient, SigaaHttpResponse } from '../http-client';

const VIEW_STATE_PATTERN = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/;
const JSESSIONID_PATTERN = /JSESSIONID=[^;]+/;

/**
 * Sessão anônima (sem login) das páginas públicas de curso e estrutura curricular. Resolver uma estrutura exige várias
 * páginas em sequência (`curriculo.jsf` → `resumo_curriculo.jsf` para a matriz → `resumo_curriculo.jsf` de novo, uma
 * vez por componente), todas no mesmo estado JSF.
 *
 * `capture` mantém o ViewState anterior quando a resposta não traz nenhum: a página de detalhe do componente (medida no
 * SIGAA real) não renderiza `<form>` e não avança a conversa JSF, então todo detalhe reaproveita o ViewState da matriz.
 *
 * Isso NÃO torna os detalhes paralelizáveis: `resumo_curriculo.jsf` também guarda na *sessão* o componente que está
 * mostrando, e POSTs sobrepostos voltam descrevendo os componentes um do outro. Quem usa isto faz as chamadas em sequência.
 */
export class PublicCurriculumSession {
  private jsessionId: string | undefined;
  private viewState: string | undefined;

  constructor(private readonly http: SigaaHttpClient) {}

  async open(path: string): Promise<string> {
    const response = await this.http.request({ method: 'GET', path });
    this.assertStatusOk(response, path);
    this.capture(response);
    if (!this.viewState) throw new Error(`Página do SIGAA sem ViewState: ${path}`);
    return response.body;
  }

  /**
   * `options.captureViewState` (padrão `true`) diz se o ViewState desta resposta (se houver) substitui o atual. Respostas
   * "folha", que não devem avançar a conversa (os detalhes de componente), passam `false`.
   */
  async post(path: string, fields: Record<string, string>, options: { captureViewState?: boolean } = {}): Promise<string> {
    if (!this.viewState) throw new Error('PublicCurriculumSession.open precisa rodar antes de post');
    const response = await this.http.request({
      method: 'POST',
      path,
      cookie: this.jsessionId,
      body: { ...fields, 'javax.faces.ViewState': this.viewState },
    });
    this.assertStatusOk(response, path);
    this.capture(response, options.captureViewState ?? true);
    return response.body;
  }

  private assertStatusOk(response: SigaaHttpResponse, path: string): void {
    if (response.status !== 200) throw new Error(`Resposta inesperada do SIGAA em ${path}: status ${response.status}`);
  }

  private capture(response: SigaaHttpResponse, captureViewState = true): void {
    const cookie = (response.headers['set-cookie'] ?? '').match(JSESSIONID_PATTERN);
    if (cookie) this.jsessionId = cookie[0];
    if (!captureViewState) return;
    const viewState = response.body.match(VIEW_STATE_PATTERN);
    if (viewState) this.viewState = viewState[1];
  }
}
