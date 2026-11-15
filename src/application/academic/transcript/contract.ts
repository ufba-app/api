import { z } from 'zod/v4';

/**
 * CONTRATO DA LEITURA DO HISTÓRICO: o JSON que a leitura entrega. As chaves são em inglês; os valores seguem o documento
 * como impresso (códigos como OB/OP, CUMP/APR, "--" e os nomes em português ficam intocados). Segue o documento de cima
 * para baixo. Não conhece banco nem app: quem precisa de outro formato escreve um adaptador por cima. Origem: a ferramenta
 * do ME #2 (`dev/ufba/poc-historico`, `src/contrato.ts`), com `contractVersion: "1"`.
 *
 *   document          "Histórico Escolar - Emitido em"
 *   program           Curso, Currículo, Período Letivo Atual, Prazo
 *   indices           IAP, CR
 *   components        tabela "Componentes Curriculares Cursados/Cursando"
 *   hours             quadro "Carga Horária e Créditos Integralizados/Pendentes"
 *   pendingMandatory  "Componentes Curriculares Obrigatórios Pendentes:N"
 *   equivalences, notes
 *   verification      o que a leitura conferiu (não vem do documento)
 *
 * Docente NUNCA faz parte do contrato (a redação o tira antes de o texto sair do servidor).
 */

/** Legenda do documento (UFBA): situações e naturezas conhecidas. O modelo é instruído a usar só estas. */
export const STATUS_CODES = ['APR', 'CANC', 'DISP', 'MATR', 'REP', 'REPF', 'REPMF', 'TRANC', 'TRANS', 'INCORP', 'CUMP'] as const;
export const KIND_CODES = ['OB', 'OP', 'EB', 'EP', 'LV', 'EC'] as const;

const Hours = z.object({ required: z.number(), completed: z.number(), pending: z.number() });

/**
 * A parte que vem do documento. É também o schema que o modelo é obrigado a seguir.
 *
 * `status` e `kind` são TEXTO (não enum fechado) de propósito: uma sigla que a UFBA passe a imprimir e que não conhecemos
 * não pode derrubar a leitura nem forçar o modelo a escolher uma sigla errada. Código fora da legenda vira AVISO
 * (`readTranscript`), e a linha segue.
 */
export const TranscriptDocumentSchema = z.object({
  document: z.object({
    /** AAAA-MM-DD, da linha "Emitido em: DD/MM/AAAA". */
    issuedOn: z.string(),
  }),
  program: z.object({
    name: z.string(),
    curriculum: z.string(),
    currentTerm: z.number(),
    completionDeadline: z.object({ standard: z.string(), maximum: z.string() }),
  }),
  indices: z.object({ cr: z.number().nullable(), iap: z.number().nullable() }),
  components: z.array(
    z.object({
      /** Como impresso, inclusive "--" nas linhas sem semestre (aproveitamento de estudos, TRANS, CUMP). */
      term: z.string(),
      /** OB, OP, EB, EP, LV, EC; nulo quando a linha não imprime natureza (trancamento). */
      kind: z.string().nullable(),
      code: z.string(),
      name: z.string(),
      hours: z.number(),
      /** Nulo quando o documento imprime "--" na coluna da nota. */
      grade: z.number().nullable(),
      status: z.string(),
    }),
  ),
  hours: z.object({ mandatory: Hours, elective: Hours, complementary: Hours, total: Hours }),
  pendingMandatory: z.object({
    /** O N do título "Componentes Curriculares Obrigatórios Pendentes:N". */
    declaredTotal: z.number(),
    items: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        hours: z.number(),
        /** Verdadeiro quando a linha tem a anotação "Matriculado". */
        enrolled: z.boolean(),
      }),
    ),
  }),
  equivalences: z.array(z.string()),
  notes: z.array(z.string()),
});

export type TranscriptDocument = z.infer<typeof TranscriptDocumentSchema>;

/** O que a leitura entrega: o documento mais o que ela conferiu. A ordem das chaves é fixa (há teste). */
export interface TranscriptContract extends TranscriptDocument {
  contractVersion: '1';
  verification: {
    /**
     * Verdadeiro quando o CR, a contagem de pendentes e a soma do quadro de horas fecharam e (com o catálogo do curso
     * pronto) o histórico confere com o curso. A soma das horas das linhas só derruba isto quando o documento NÃO tem
     * linhas de aproveitamento (semestre "--"); com elas é só aviso.
     */
    verified: boolean;
    /** Tudo o que não fechou, duro ou brando. O dado é entregue de qualquer forma. */
    warnings: string[];
    /** Quem leu o documento. */
    reader: 'ai' | 'parser';
  };
}
