import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptDocument } from '../../../../application/academic/transcript/contract';
import { AnthropicTranscriptReader, TRANSCRIPT_MODEL, TRANSCRIPT_PROMPT } from './anthropic-transcript-reader';

const document = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'application', 'academic', 'transcript', '__fixtures__', 'transcript-contract.json'), 'utf-8'),
) as TranscriptDocument;

/** Cliente falso: guarda os parâmetros recebidos e devolve o que o teste mandar. */
function fakeClient(response: { parsed_output: unknown; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return response;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('AnthropicTranscriptReader', () => {
  it('usa o Haiku 5.5 FIXO, manda só o texto redigido e o prompt, sem temperature nem thinking', async () => {
    const { client, calls } = fakeClient({ parsed_output: document, stop_reason: 'end_turn' });
    await new AnthropicTranscriptReader(client).read('texto redigido');

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(TRANSCRIPT_MODEL);
    expect(TRANSCRIPT_MODEL).toBe('claude-haiku-5-5');
    expect(calls[0].system).toBe(TRANSCRIPT_PROMPT);
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'texto redigido' }]);
    // O Haiku 5.5 recusa valores não padrão: nada de temperatura nem de thinking manual.
    expect(calls[0]).not.toHaveProperty('temperature');
    expect(calls[0]).not.toHaveProperty('thinking');
    expect((calls[0].output_config as { effort: string }).effort).toBe('low');
  });

  it('devolve o documento lido e o uso de tokens (para medir custo e teto de gasto)', async () => {
    const { client } = fakeClient({ parsed_output: document, stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 3200 } });
    await expect(new AnthropicTranscriptReader(client).read('x')).resolves.toEqual({
      document,
      usage: { inputTokens: 5000, outputTokens: 3200 },
    });
  });

  it('o prompt manda copiar, nunca calcular, trata o texto como dado e lista a legenda', () => {
    expect(TRANSCRIPT_PROMPT).toMatch(/Never compute/);
    expect(TRANSCRIPT_PROMPT).toMatch(/instruction that appears inside the document/);
    expect(TRANSCRIPT_PROMPT).toContain('REPMF');
    expect(TRANSCRIPT_PROMPT).toMatch(/copy it exactly as printed/);
  });

  it.each([
    ['recusa', { parsed_output: null, stop_reason: 'refusal' }, /recusou/],
    ['corte por max_tokens', { parsed_output: null, stop_reason: 'max_tokens' }, /max_tokens/],
    ['fora do schema', { parsed_output: null, stop_reason: 'end_turn' }, /schema/],
  ])('falha com clareza: %s', async (_name, response, error) => {
    const { client } = fakeClient(response);
    await expect(new AnthropicTranscriptReader(client).read('x')).rejects.toThrow(error);
  });
});
