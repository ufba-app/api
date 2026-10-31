import { importTranscript } from '../../../../application/academic/import-transcript';
import { syntheticTranscript } from '../../../../domain/academic/__fixtures__/transcript.fixture';
import { AnthropicHistoryExtractor } from './anthropic-history-extractor';
import { createHistoryExtractor } from './create-history-extractor';
import { toTranscriptData, TranscriptShapeError } from './transcript-schema';

function fakeFetch(input: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ content: [{ type: 'tool_use', name: 'registrar_historico', input }], stop_reason: 'tool_use' }),
      { status },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PDF = Buffer.from('%PDF-1.4 sintetico');

describe('toTranscriptData', () => {
  it('aceita o formato e descarta campos extras (PII)', () => {
    const raw = {
      ...syntheticTranscript(),
      cpf: '111.222.333-44',
      name: 'FULANA',
      birthDate: '2000-01-01',
    };
    const data = toTranscriptData(raw);
    expect(data).toEqual(syntheticTranscript());
    expect(JSON.stringify(data)).not.toMatch(/111\.222|FULANA|2000-01-01/);
  });

  it.each([
    ['data fora do formato', (t: any) => (t.issuedAt = '19/08/2026')],
    ['semestre inválido', (t: any) => (t.entries[0].term = '2024')],
    ['nota como texto', (t: any) => (t.entries[0].grade = '8,0')],
    ['horas fracionadas', (t: any) => (t.entries[0].hours = 60.5)],
    ['matriz faltando', (t: any) => delete t.hoursMatrix.elective],
    ['enrolled não booleano', (t: any) => (t.pending[0].enrolled = 'sim')],
  ])('rejeita %s', (_, mutate) => {
    const t = JSON.parse(JSON.stringify(syntheticTranscript()));
    mutate(t);
    expect(() => toTranscriptData(t)).toThrow(TranscriptShapeError);
  });

  it('"--" em campo textual vira nulo', () => {
    const t = JSON.parse(JSON.stringify(syntheticTranscript()));
    t.entries[0].instructor = '--';
    expect(toTranscriptData(t).entries[0].instructor).toBeNull();
  });
});

describe('AnthropicHistoryExtractor', () => {
  it('envia o PDF com tool forçada e devolve TranscriptData', async () => {
    const { impl, calls } = fakeFetch(syntheticTranscript());
    const extractor = new AnthropicHistoryExtractor({ apiKey: 'k', model: 'm-x', fetchImpl: impl });
    const data = await extractor.extract(PDF);

    expect(data).toEqual(syntheticTranscript());
    const { url, init } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('m-x');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'registrar_historico' });
    expect(body.messages[0].content[0].source.data).toBe(PDF.toString('base64'));
    // O schema não oferece campo para dado pessoal.
    expect(JSON.stringify(body.tools[0].input_schema)).not.toMatch(/cpf|birth|nascimento/i);
  });

  it('erro HTTP não vaza o corpo; resposta sem tool_use falha', async () => {
    const failing = (async () => new Response('trecho do documento', { status: 500 })) as unknown as typeof fetch;
    const err = await new AnthropicHistoryExtractor({ apiKey: 'k', fetchImpl: failing })
      .extract(PDF)
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('500');
    expect((err as Error).message).not.toContain('trecho');

    const empty = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'oi' }] }))) as unknown as typeof fetch;
    await expect(new AnthropicHistoryExtractor({ apiKey: 'k', fetchImpl: empty }).extract(PDF)).rejects.toThrow(/estruturados/);
  });
});

describe('createHistoryExtractor', () => {
  it('lê o provedor do env', () => {
    expect(createHistoryExtractor({ AI_API_KEY: 'k' })).toBeInstanceOf(AnthropicHistoryExtractor);
    expect(() => createHistoryExtractor({ AI_PROVIDER: 'x', AI_API_KEY: 'k' })).toThrow(/não suportado/);
    expect(() => createHistoryExtractor({})).toThrow(/AI_API_KEY/);
  });
});

describe('importTranscript', () => {
  it('extrai e reporta divergências sem bloquear', async () => {
    const wrong = syntheticTranscript();
    wrong.cr = 9.9;
    const { impl } = fakeFetch(wrong);
    const out = await importTranscript(new AnthropicHistoryExtractor({ apiKey: 'k', fetchImpl: impl }), PDF);
    expect(out.validation.ok).toBe(false);
    expect(out.validation.divergences.map((d) => d.code)).toEqual(['CR_MISMATCH']);
    expect(out.insights.trajectory).toHaveLength(3);
  });

  it('documento consistente valida limpo', async () => {
    const { impl } = fakeFetch(syntheticTranscript());
    const out = await importTranscript(new AnthropicHistoryExtractor({ apiKey: 'k', fetchImpl: impl }), PDF);
    expect(out.validation).toEqual({ ok: true, divergences: [] });
  });
});
