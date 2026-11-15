import type { SyncProvider } from './sync-provider';

export interface SyncJobDeps {
  providers: readonly SyncProvider[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Uma execução do cron genérico de sincronização. Para cada provedor, em ordem: sincroniza quem `dueUsers` devolve
 * (até o teto do provedor), com `spacingMs` entre pessoas. Um provedor que falha ao listar ou que cai no breaker
 * (`maxConsecutiveUnavailable` `UNAVAILABLE` seguidos) não impede os demais.
 * 0 = a execução rodou; 1 = há provedores e `dueUsers` falhou para todos.
 * Loga só texto fixo e contagens: nunca ids de usuário nem mensagens de erro.
 */
export async function runSyncJob(deps: SyncJobDeps, log: (line: string) => void = console.log): Promise<0 | 1> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (deps.providers.length === 0) {
    log('sync: nenhum provedor registrado');
    return 0;
  }
  let listFailures = 0;
  for (const provider of deps.providers) {
    let ids: string[];
    try {
      ids = await provider.dueUsers(now(), provider.maxUsersPerRun);
    } catch {
      log(`sync: ${provider.key} não foi possível listar quem sincronizar`);
      listFailures++;
      continue;
    }
    const c = { ok: 0, reconnect: 0, unavailable: 0, busy: 0, disconnected: 0, failed: 0 };
    let streak = 0;
    let interrupted = false;
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) await sleep(provider.spacingMs);
      try {
        const r = await provider.syncUser(ids[i]);
        streak = r === 'UNAVAILABLE' ? streak + 1 : 0;
        if (r === 'OK') c.ok++;
        else if (r === 'RECONNECT_REQUIRED') c.reconnect++;
        else if (r === 'UNAVAILABLE') c.unavailable++;
        else if (r === 'BUSY') c.busy++;
        else if (r === 'DISCONNECTED') c.disconnected++;
        else c.failed++;
      } catch {
        c.failed++;
        streak = 0;
      }
      if (streak >= provider.maxConsecutiveUnavailable) {
        interrupted = true;
        break;
      }
    }
    log(
      `sync: ${provider.key} ${ids.length} devidos, ${c.ok} ok, ${c.reconnect} reconnect, ` +
        `${c.unavailable} unavailable, ${c.busy} busy, ${c.disconnected} disconnected, ${c.failed} falhas` +
        (interrupted ? ', rodada interrompida: provedor indisponível várias vezes seguidas' : ''),
    );
  }
  return listFailures === deps.providers.length ? 1 : 0;
}
