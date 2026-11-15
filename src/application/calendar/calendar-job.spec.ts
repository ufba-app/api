import { runCalendarJob } from './calendar-job';
import type { WatchSummary } from './calendar-watcher';

const summary = (p: Partial<WatchSummary> = {}): WatchSummary => ({ ran: true, considered: 1, published: 1, notVerified: 0, errors: 0, skipped: 0, ...p });

describe('runCalendarJob', () => {
  it('rodou: código 0 e só contagens no log', async () => {
    const lines: string[] = [];
    expect(await runCalendarJob({ run: async () => summary() }, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['calendário: 1 considerados, 1 publicados, 0 não verificados, 0 erros, 0 sem novidade']);
  });

  it('a página falhou (ERROR registrado no log, painel alerta): ainda código 0', async () => {
    expect(await runCalendarJob({ run: async () => summary({ errors: 1, published: 0, considered: 0 }) }, () => undefined)).toBe(0);
  });

  it('nada rodou (sem chave da IA, ou já havia uma execução): código 1', async () => {
    expect(await runCalendarJob({ run: async () => summary({ ran: false }) }, () => undefined)).toBe(1);
  });

  it('exceção inesperada: código 1 e a mensagem do erro não vai para o log', async () => {
    const lines: string[] = [];
    const code = await runCalendarJob({ run: async () => { throw new Error('segredo-na-mensagem'); } }, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join(' ')).not.toContain('segredo');
  });
});
