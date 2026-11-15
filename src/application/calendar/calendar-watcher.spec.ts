import {
  FakeCalendarReader,
  FakeCalendarSource,
  FakeCalendarText,
  InMemoryCalendarLogs,
  brokenCalendar,
  perfectCalendar,
} from '../../../test/support/calendar-fake';
import { CalendarWatcher, ERROR_RETRY_AFTER_MS } from './calendar-watcher';

const URL_26_2 = 'https://supac.ufba.br/sites/supac.ufba.br/files/calendario_2026.2_27.10.26.pdf';
const URL_26_1 = 'https://supac.ufba.br/sites/supac.ufba.br/files/calendario_2026.1_06.08.2026.pdf';
const pdf = (conteudo: string) => Buffer.from(`%PDF-1.7 ${conteudo}`);

function make(reader: FakeCalendarReader | null = new FakeCalendarReader()) {
  const logs = new InMemoryCalendarLogs();
  const source = new FakeCalendarSource();
  const extractor = new FakeCalendarText();
  let now = new Date('2026-11-15T12:00:00Z');
  logs.now = () => now;
  source.links = [
    { term: '2026.2', url: URL_26_2 },
    { term: '2026.1', url: URL_26_1 },
  ];
  source.pdfs.set(URL_26_2, pdf('a'));
  source.pdfs.set(URL_26_1, pdf('b'));
  const watcher = new CalendarWatcher(logs, source, extractor, reader, () => now);
  return { logs, source, watcher, reader, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('CalendarWatcher', () => {
  it('primeira execução lê só o calendário mais recente e publica; os anteriores não entram no log', async () => {
    const { logs, source, watcher, reader } = make();
    const r = await watcher.run();
    expect(r).toMatchObject({ ran: true, considered: 1, published: 1 });
    expect(source.downloads).toBe(1);
    expect(reader!.calls).toBe(1);
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({
      status: 'PUBLISHED',
      verified: true,
      term: '2026.2',
      sourceUrl: URL_26_2,
      model: 'claude-haiku-5-5',
      inputTokens: 20_000,
      outputTokens: 20_000,
    });
    expect(logs.rows[0]!.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.rows[0]!.contract?.keyDates.termEnd).toBe('2026-12-19');
  });

  it('sem arquivo novo ou diferente não faz nada de caro (mesmo hash não é lido duas vezes)', async () => {
    const { logs, watcher, reader } = make();
    await watcher.run();
    const r = await watcher.run();
    expect(r).toMatchObject({ considered: 1, skipped: 1, published: 0 });
    expect(reader!.calls).toBe(1);
    expect(logs.rows).toHaveLength(1);
  });

  it('o mesmo semestre reeditado (arquivo diferente) é lido e vira outro registro publicado', async () => {
    const { logs, source, watcher, reader } = make();
    await watcher.run();
    source.pdfs.set(URL_26_2, pdf('reedição com datas alteradas'));
    const r = await watcher.run();
    expect(r.published).toBe(1);
    expect(reader!.calls).toBe(2);
    expect(logs.rows).toHaveLength(2);
  });

  it('um semestre novo na página é lido (o semestre do documento vale mais que o do link); os antigos continuam de fora', async () => {
    const { logs, source, watcher } = make();
    await watcher.run();
    const url = 'https://supac.ufba.br/x/calendario_2027.1.pdf';
    source.links = [{ term: '2027.1', url }, ...source.links];
    source.pdfs.set(url, pdf('novo'));
    const r = await watcher.run();
    expect(r).toMatchObject({ considered: 2, skipped: 1, published: 1 });
    expect(logs.rows.at(-1)).toMatchObject({ sourceUrl: url, term: '2026.2' }); // o documento de teste diz 2026.2
  });

  it('leitura que não fecha: relê uma vez; se segue sem fechar, NOT_VERIFIED, sem publicar, tokens das duas', async () => {
    const reader = new FakeCalendarReader();
    reader.queue = [brokenCalendar()];
    const { logs, watcher } = make(reader);
    const r = await watcher.run();
    expect(r).toMatchObject({ notVerified: 1, published: 0 });
    expect(reader.calls).toBe(2);
    const row = logs.rows[0]!;
    expect(row).toMatchObject({ status: 'NOT_VERIFIED', verified: false, term: '2026.2', inputTokens: 40_000, outputTokens: 40_000 });
    expect(row.warnings.join(' ')).toMatch(/Dias letivos/);
    expect((await logs.listPublished())).toHaveLength(0);
  });

  it('a releitura que fecha publica (alarme falso evitado)', async () => {
    const reader = new FakeCalendarReader();
    reader.queue = [brokenCalendar(), perfectCalendar()];
    const { logs, watcher } = make(reader);
    expect(await watcher.run()).toMatchObject({ published: 1, notVerified: 0 });
    expect(reader.calls).toBe(2);
    expect(logs.rows[0]!.status).toBe('PUBLISHED');
  });

  it('falha da IA nas duas tentativas: ERROR com o semestre do link; só tenta de novo depois de 6 dias, na mesma linha, mantendo o "Visto"', async () => {
    const reader = new FakeCalendarReader();
    reader.queue = [new Error('sem crédito')];
    const { logs, watcher, advance } = make(reader);
    await watcher.run();
    expect(reader.calls).toBe(2);
    const first = logs.rows[0]!;
    expect(first).toMatchObject({ status: 'ERROR', term: '2026.2', verified: null, contract: null });
    expect(first.warnings[0]).toContain('sem crédito');

    await logs.markSeen(first.id, 'u1', new Date());
    expect((await watcher.run()).skipped).toBe(1);
    expect(reader.calls).toBe(2);

    advance(ERROR_RETRY_AFTER_MS + 1000);
    reader.queue = [perfectCalendar()];
    reader.calls = 0;
    await watcher.run();
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ id: first.id, status: 'PUBLISHED', seen: true });
  });

  it('PDF que dá 404 vira ERROR só dele (sem hash) e não derruba os outros', async () => {
    const { logs, source, watcher } = make();
    // Já há um log de 2026.1: a leitura olha de 2026.1 em diante.
    await logs.create({ sourceUrl: 'x', sourceSha256: 'a'.repeat(64), term: '2026.1', status: 'PUBLISHED', verified: true, warnings: [], contract: null, model: null, inputTokens: null, outputTokens: null });
    source.pdfs.set(URL_26_2, new Error('HTTP 404'));
    const r = await watcher.run();
    expect(r).toMatchObject({ considered: 2, errors: 1, published: 1 });
    const erro = logs.rows.find((x) => x.status === 'ERROR')!;
    expect(erro).toMatchObject({ sourceUrl: URL_26_2, term: '2026.2', sourceSha256: null });
    expect(erro.warnings[0]).toContain('HTTP 404');
    // Na semana seguinte (dentro de 6 dias) não repete a linha nem a chamada.
    const downloads = source.downloads;
    await watcher.run();
    expect(logs.rows.filter((x) => x.status === 'ERROR')).toHaveLength(1);
    expect(source.downloads).toBe(downloads + 1); // só o 2026.1, que já é conhecido
  });

  it('página fora do ar ou sem links de calendário: ERROR sem semestre, uma linha só', async () => {
    const { logs, source, watcher } = make();
    source.pageError = new Error('HTTP 503');
    await watcher.run();
    await watcher.run();
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ status: 'ERROR', term: null, sourceSha256: null });
    expect(logs.rows[0]!.warnings[0]).toContain('HTTP 503');

    source.pageError = null;
    source.links = [];
    await watcher.run();
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]!.warnings[0]).toMatch(/não tem links/);
  });

  it('sem leitor (sem chave da IA) não roda nada', async () => {
    const { logs, source, watcher } = make(null);
    expect(watcher.available()).toBe(false);
    expect(await watcher.run()).toMatchObject({ ran: false });
    expect(source.downloads).toBe(0);
    expect(logs.rows).toHaveLength(0);
  });
});
