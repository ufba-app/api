import type { HistoryExtractor } from '../../../../application/ports/history-extractor';
import { AnthropicHistoryExtractor } from './anthropic-history-extractor';

export interface HistoryExtractorEnv {
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}

/** Escolhe o provedor por env: AI_PROVIDER (padrão `anthropic`), AI_API_KEY, AI_MODEL. */
export function createHistoryExtractor(
  env: HistoryExtractorEnv = process.env,
  fetchImpl?: typeof fetch,
): HistoryExtractor {
  const provider = (env.AI_PROVIDER ?? 'anthropic').toLowerCase();
  if (!env.AI_API_KEY) {
    throw new Error('AI_API_KEY não configurada: a extração do histórico precisa dela');
  }
  switch (provider) {
    case 'anthropic':
      return new AnthropicHistoryExtractor({
        apiKey: env.AI_API_KEY,
        model: env.AI_MODEL || undefined,
        fetchImpl,
      });
    default:
      throw new Error(`AI_PROVIDER "${provider}" não suportado (disponível: anthropic)`);
  }
}
