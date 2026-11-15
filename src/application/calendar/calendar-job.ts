import type { WatchSummary } from './calendar-watcher';

/**
 * Uma execução do cron do calendário: roda o verificador e devolve o código de saída do processo.
 * 0 = rodou (mesmo que a página tenha falhado: isso fica registrado como ERROR e alerta no painel);
 * 1 = a execução inteira falhou (sem leitor da IA, já havia uma rodando, ou exceção inesperada).
 * Loga só contagens, nunca nomes, URLs com dado, conteúdo de PDF ou mensagem de erro.
 */
export async function runCalendarJob(
  watcher: { run(): Promise<WatchSummary> },
  log: (line: string) => void = console.log,
): Promise<number> {
  try {
    const r = await watcher.run();
    if (!r.ran) {
      log('calendário: nada rodou (sem ANTHROPIC_API_KEY ou já havia uma leitura em andamento)');
      return 1;
    }
    log(
      `calendário: ${r.considered} considerados, ${r.published} publicados, ${r.notVerified} não verificados, ${r.errors} erros, ${r.skipped} sem novidade`,
    );
    return 0;
  } catch {
    log('calendário: a execução falhou');
    return 1;
  }
}
