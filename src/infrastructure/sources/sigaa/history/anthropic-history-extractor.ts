import type { HistoryExtractor } from '../../../../application/ports/history-extractor';
import type { TranscriptData } from '../../../../domain/academic';
import { TRANSCRIPT_JSON_SCHEMA, toTranscriptData } from './transcript-schema';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TOOL_NAME = 'registrar_historico';

const SYSTEM_PROMPT = `Você extrai dados acadêmicos do PDF de um Histórico Escolar da UFBA (SIGAA).
Regras:
- Chame a ferramenta ${TOOL_NAME} uma única vez, com os dados exatamente como o documento imprime.
- NUNCA extraia CPF, RG, nome do aluno, data de nascimento, filiação ou qualquer dado pessoal. Eles não têm campo.
- Não calcule nem corrija nada: copie CR, IAP e a matriz de carga horária como estão impressos.
- Uma linha por componente cursado, incluindo trancamentos (nature nulo, grade nulo). Nota "--" vira null.
- Status e natureza são as siglas impressas. Datas em AAAA-MM-DD.
- "pending" são os componentes obrigatórios pendentes; enrolled=true quando anotados como Matriculado. Inclua ENADE se listado.`;

export class HistoryExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryExtractionError';
  }
}

export interface AnthropicExtractorOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Extrator via API da Anthropic por fetch (sem SDK). Envia o PDF como bloco `document` e força o
 * uso de uma ferramenta com JSON Schema, o que dá JSON estrito. Não loga o PDF nem a resposta.
 */
export class AnthropicHistoryExtractor implements HistoryExtractor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(options: AnthropicExtractorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.baseUrl ?? ANTHROPIC_URL;
  }

  async extract(pdf: Buffer): Promise<TranscriptData> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: TOOL_NAME,
            description: 'Registra os dados acadêmicos extraídos do histórico.',
            input_schema: TRANSCRIPT_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdf.toString('base64'),
                },
              },
              { type: 'text', text: 'Extraia os dados acadêmicos deste histórico.' },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      // Só o status: o corpo de erro pode ecoar trechos do documento.
      throw new HistoryExtractionError(
        `A API de IA respondeu ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      content?: { type: string; name?: string; input?: unknown }[];
      stop_reason?: string;
    };
    const call = payload.content?.find(
      (b) => b.type === 'tool_use' && b.name === TOOL_NAME,
    );
    if (!call) {
      throw new HistoryExtractionError(
        `A IA não devolveu os dados estruturados (stop_reason ${payload.stop_reason ?? '?'})`,
      );
    }
    return toTranscriptData(call.input);
  }
}
