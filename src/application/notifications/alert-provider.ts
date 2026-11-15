/** O que uma avaliação devolveu, em contagens (nunca ids de pessoa nem texto de aviso). */
export interface AlertResult {
  /** Avisos que saíram para algum aparelho. */
  sent: number;
  /** Avisos dados como enviados sem enviar (`Notifier.record` com `suppressed`). */
  suppressed: number;
  /** Nada a avisar agora (sem aparelho, silêncio, ajuste desligado, duplicata, nada devido). */
  skipped: number;
  failed: number;
}

/**
 * Contrato de uma fonte de avisos para o `notify-cron` (`node dist/src/notify-job.js`). A fonte só decide O QUE avisar e
 * QUANDO (lendo o banco, nunca a fonte externa) e envia pelo `Notifier`; o canal, o silêncio e a anti-duplicata são dele.
 */
export interface AlertProvider {
  /** Nome curto da fonte (`siasb`), só para a linha de contagens do log. */
  readonly key: string;
  /** Quem vale avaliar nesta rodada (ex.: quem tem a fonte conectada). */
  usersToEvaluate(): Promise<string[]>;
  /** Avalia uma pessoa e envia o que estiver devido. NUNCA lança. */
  evaluateUser(userId: string, now: Date): Promise<AlertResult>;
}

/** Token de injeção da lista de provedores (cada fonte entra na fábrica em `mcp-wiring.ts`). */
export const ALERT_PROVIDERS = Symbol('ALERT_PROVIDERS');
