import type { SiasbCopyRepository } from '../ports/siasb-copy';
import type { SiasbSyncer } from './siasb-syncer';

export const SYNC_MAX_USERS_PER_RUN = 200;
export const SYNC_SPACING_MS = 1500;
/** Depois de tantos `UNAVAILABLE` seguidos o SIASB está fora do ar: a rodada para (a próxima tenta de novo). */
export const SYNC_MAX_CONSECUTIVE_UNAVAILABLE = 3;

export interface SiasbJobDeps {
  syncer: Pick<SiasbSyncer, 'syncUser'>;
  copy: Pick<SiasbCopyRepository, 'dueUsers'>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Uma execução do cron do SIASB (fase 1: sincronizar). Sincroniza, em ordem, quem `dueUsers` devolve (até o teto),
 * com um espaço entre pessoas. 0 = o laço rodou (mesmo com falhas por pessoa); 1 = `dueUsers` falhou.
 * Depois de `SYNC_MAX_CONSECUTIVE_UNAVAILABLE` resultados `UNAVAILABLE` seguidos, a rodada para (código 0).
 * Loga só contagens: nunca ids de usuário nem mensagens de erro. `DISCONNECTED` só é contado, sem ação.
 */
export async function runSiasbJob(deps: SiasbJobDeps, log: (line: string) => void = console.log): Promise<0 | 1> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let ids: string[];
  try {
    ids = await deps.copy.dueUsers(now(), SYNC_MAX_USERS_PER_RUN);
  } catch {
    log('siasb: não foi possível listar quem sincronizar');
    return 1;
  }
  const c = {
    ok: 0,
    reconnect: 0,
    unavailable: 0,
    busy: 0,
    disconnected: 0,
    failed: 0,
  };
  let streak = 0;
  let interrupted = false;
  for (let i = 0; i < ids.length; i++) {
    if (i > 0) await sleep(SYNC_SPACING_MS);
    try {
      const r = await deps.syncer.syncUser(ids[i]);
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
    if (streak >= SYNC_MAX_CONSECUTIVE_UNAVAILABLE) {
      interrupted = true;
      break;
    }
  }
  log(
    `siasb: ${ids.length} devidos, ${c.ok} ok, ${c.reconnect} reconnect, ${c.unavailable} unavailable, ` +
      `${c.busy} busy, ${c.disconnected} disconnected, ${c.failed} falhas` +
      (interrupted ? ', rodada interrompida: SIASB indisponível várias vezes seguidas' : ''),
  );
  return 0;
}
