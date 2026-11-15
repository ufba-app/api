import { z } from 'zod/v4';

/**
 * CONTRATO DO CALENDÁRIO ACADÊMICO — o JSON que a ferramenta entrega.
 *
 * Mais estruturado que o do histórico: nada de data como texto livre. Toda data é
 * ISO (AAAA-MM-DD) e o "quando" de cada evento é uma união discriminada (`when`),
 * porque o PDF mistura data única, intervalo, "Até", "A partir de", reaberturas,
 * "A definir", "A qualquer tempo", "Suspenso", remissão a link e prazos relativos.
 * Textos (descrições, responsáveis, nomes) são copiados como impressos.
 *
 * Não conhece banco nem app. Quem precisar de outro formato escreve um adaptador.
 *
 *   document        título, período e data de divulgação
 *   keyDates        quadro "DATAS LIMITES"
 *   events          as tabelas de procedimentos (as duas visões do PDF viram uma lista só)
 *   teachingDays    quadro "DIAS LETIVOS"
 *   nonTeachingDays "FERIADOS e DATAS NÃO LETIVAS" (dia ou intervalo)
 *   otherEvents     "DIVERSOS"
 *   verification    o que a ferramenta conferiu (não vem do documento)
 */

const IsoDate = z.string().describe('YYYY-MM-DD');
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DateRange = z.object({ start: IsoDate, end: IsoDate });

/** Quando algo acontece. Cada variante só tem os campos que fazem sentido. */
const On = z.object({ type: z.literal('on'), date: IsoDate });
const Between = z.object({ type: z.literal('between'), start: IsoDate, end: IsoDate });
/** "Até 09/06/2026" */
const Until = z.object({ type: z.literal('until'), date: IsoDate });
/** "A partir de 17/08/2026" */
const From = z.object({ type: z.literal('from'), date: IsoDate });
/** Sem data: "A definir", "A qualquer tempo", "Suspenso para o período", "Consultar <link>",
 *  "De acordo com edital de cada Programa", "7 dias corridos após a solicitação"... */
const Undetermined = z.object({
  type: z.literal('undetermined'),
  reason: z.enum(['tbd', 'anytime', 'suspended', 'see-link', 'per-notice', 'relative', 'other']),
  /** O texto impresso na coluna DATA. */
  text: z.string(),
});

// Cada uniao entra inteira na gramática que o provedor compila; o limite dela é fixo.
// Por isso `until` e `from` só existem nos eventos; `otherEvents` aceita dia, intervalo e sem data;
// `nonTeachingDays` só tem dia ou intervalo.
export const WhenSchema = z.discriminatedUnion('type', [On, Between, Until, From, Undetermined]);
const WhenSimples = z.discriminatedUnion('type', [On, Between, Undetermined]);
export type When = z.infer<typeof WhenSchema>;

export const CalendarDocumentSchema = z.object({
  document: z.object({
    /** "2026.2" */
    term: z.string(),
    /** "Data Divulgação: DD/MM/AAAA"; null nos calendários que não imprimem. */
    publishedOn: IsoDate.nullable(),
  }),
  keyDates: z.object({
    termStart: IsoDate,
    progress25: IsoDate,
    progress50: IsoDate,
    progress75: IsoDate,
    termEnd: IsoDate,
    /** Período do Internato; null quando o calendário não traz. */
    internship: DateRange.nullable(),
  }),
  events: z.array(
    z.object({
      /** Título da seção em que a linha aparece na visão por procedimento, ex. "MATRÍCULA GRADUAÇÃO". */
      section: z.string(),
      /** Coluna PROCEDIMENTO, ex. "Matrícula". */
      procedure: z.string(),
      /** Coluna RESPONSÁVEL, separada em itens. Vazio se a linha não imprime. */
      responsibles: z.array(z.string()),
      /** Coluna ROTINAS ACADÊMICAS. */
      description: z.string(),
      when: WhenSchema,
      /** Janelas extras do MESMO evento: "Reabertura: ..." ou dias soltos ("13, 14, 17 e 18/03" = quatro janelas de um dia; o primeiro dia fica em `when`). */
      additionalWindows: z.array(DateRange),
      /** true quando a data vem marcada com * (alteração de data). */
      dateChanged: z.boolean(),
      /** URLs citadas na linha. */
      links: z.array(z.string()),
    }),
  ),
  teachingDays: z.object({
    byMonth: z.array(z.object({ month: z.string().describe('YYYY-MM'), days: z.number() })),
    total: z.number(),
  }),
  /**
   * "FERIADOS e DATAS NÃO LETIVAS". Um dia (`on`) ou um intervalo (`between`),
   * como "Recesso Festas de final de ano 22/12 a 31/12" ou uma suspensão de
   * atividades letivas. Nenhum desses dias conta como dia letivo.
   */
  nonTeachingDays: z.array(
    z.object({
      name: z.string(),
      when: z.discriminatedUnion('type', [
        On,
        Between,
      ]),
      /** O dia da semana impresso entre parênteses; null quando não é impresso (intervalos). */
      weekday: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).nullable(),
      dateChanged: z.boolean(),
    }),
  ),
  otherEvents: z.array(
    z.object({
      name: z.string(),
      when: WhenSimples,
      links: z.array(z.string()),
    }),
  ),
});

export type CalendarDocument = z.infer<typeof CalendarDocumentSchema>;

export interface CalendarContract extends CalendarDocument {
  contractVersion: '1';
  verification: {
    /** true quando nenhuma invariante falhou. O dado é entregue de qualquer forma. */
    verified: boolean;
    warnings: string[];
    reader: 'ai';
  };
}
