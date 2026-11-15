/** Origem do SIGAA: o único destino que a página de lançamento (e a CSP dela) aceita. */
export const SIGAA_ORIGIN = 'https://sigaa.ufba.br';

/** O formulário de login do SIGAA como a página dele o entrega: para onde envia e os campos ocultos (sem segredo). */
export interface SigaaLoginForm {
  /** Caminho do `action` (ex.: `/sigaa/logar.do?dispatch=logOn`). */
  action: string;
  /** Campos ocultos e fixos que o formulário envia (token, largura, etc.), sem login nem senha. */
  fields: Record<string, string>;
}

/** De onde vem o formulário de login do SIGAA (uma leitura anônima da página de login, sem credencial nenhuma). */
export abstract class SigaaLoginFormSource {
  abstract fetch(): Promise<SigaaLoginForm>;
}
