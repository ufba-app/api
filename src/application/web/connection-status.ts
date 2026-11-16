import type { ClassroomLinkPort } from '../oauth/oauth-ports';
import type { SigaaMasterSlotRepository, SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import type { SiasbLink } from '../siasb/siasb-link';
import { CofreSigaa, CredencialSigaaInvalidaError } from '../sigaa/cofre-sigaa';
import type { SyncResult } from '../ports/siasb-copy';
import type { SourceHealthRepository, SourceHealthRow } from '../ports/source-health';
import { accountHealth, findRecord, siasbHealth, sigaaHealth } from './connection-health';
import { webCopyOf, type AccountStatus, type GuestApp, type Me, type RequestInfo, type WebPrincipal } from './web-api';

export const accountStatus = (a: SourceAccountRecord): AccountStatus =>
  a.status === 'OK' ? 'connected' : 'reconnect_required';
export const fromApp = (a: 'ufba' | 'convidado'): GuestApp => (a === 'convidado' ? 'guest' : 'ufba');

/**
 * Estado das conexões de quem está logado no web (lido por /me, pela tela de autorização e ao sair). A senha do
 * SIGAA do web só abre com a K da sessão: "conectado" quer dizer "esta sessão consegue usar".
 */
type Core<K extends keyof Me['connections']> = Omit<Me['connections'][K], 'health'>;

export class ConnectionStatus {
  constructor(
    private readonly cofre: CofreSigaa,
    private readonly accounts: SourceAccountRepository,
    private readonly classroom: ClassroomLinkPort,
    private readonly slots: SigaaMasterSlotRepository,
    private readonly siasbLink: SiasbLink,
    private readonly now: () => number = Date.now,
    /** Teto de espera pelo SIASB no /me; estourou, vale `offered: false` (nada é guardado). */
    private readonly offerTimeoutMs: number = 2500,
    /** Saúde gravada das leituras (`source_health`); sem ele, nenhuma conta tem registro (vira `unknown`). */
    private readonly healthRepo?: SourceHealthRepository,
  ) {}

  private async healthRows(userId: string): Promise<SourceHealthRow[]> {
    try {
      return (await this.healthRepo?.list(userId)) ?? [];
    } catch {
      return [];
    }
  }

  private async offered(userId: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.offerTimeoutMs);
    });
    try {
      return await Promise.race([this.siasbLink.offer(userId).then((o) => o.offered, () => false), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * SIASB: já conectado, "oferecido" depende só de a matrícula estar importada (sem consultar o SIASB). Sessão com fim estimado já passado vale como
   * reconnect_required. Falha ao consultar nunca derruba o /me.
   */
  async siasb(p: WebPrincipal): Promise<Core<'siasb'>> {
    return this.siasbOf(p.userId);
  }

  async siasbOf(userId: string): Promise<Core<'siasb'>> {
    return (await this.siasbDetail(userId)).view;
  }

  /** A visão do SIASB mais o que a saúde precisa (resultado da última sincronização). */
  private async siasbDetail(userId: string): Promise<{ view: Core<'siasb'>; syncResult: SyncResult | null }> {
    const gone = { view: { offered: false, status: 'disconnected', expiresAt: null, syncedAt: null } as Core<'siasb'>, syncResult: null };
    try {
      const s = await this.siasbLink.status(userId);
      if (s.state === 'disconnected') {
        const offered = await this.offered(userId);
        return { view: { offered, status: 'disconnected', expiresAt: null, syncedAt: null }, syncResult: null };
      }
      const expired = s.expiresAt !== null && s.expiresAt.getTime() <= this.now();
      // Já conectado: só o banco decide a oferta (matrícula importada); matrícula apagada não vira erro nem consulta o SIASB.
      const offered = await this.siasbLink.hasRegistration(userId).catch(() => false);
      return {
        view: {
          offered,
          status: s.state === 'connected' && !expired ? 'connected' : 'reconnect_required',
          expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
          syncedAt: s.syncedAt ? s.syncedAt.toISOString() : null,
        },
        syncResult: s.syncResult,
      };
    } catch {
      return gone;
    }
  }

  async sigaa(p: WebPrincipal): Promise<Core<'sigaa'>> {
    const slots = await this.slots.count(p.userId);
    const passkey = { slots };
    const cofre = await this.cofre.cofre(p.userId);
    if (!cofre) return { status: 'disconnected', login: null, passkey };
    // O SIGAA recusou a senha do cofre: vale para todos até a pessoa digitar a nova.
    if (cofre.status !== 'OK') return { status: 'password_required', login: cofre.login, passkey };
    if (await this.sigaaOpens(p)) return { status: 'connected', login: cofre.login, passkey };
    // `locked`: esta sessão não abre o cofre, mas há passkey (um toque religa, com a DK que ela guarda).
    return { status: slots > 0 ? 'locked' : 'password_required', login: cofre.login, passkey };
  }

  /** A pessoa tem conexão com a fonte, em qualquer estado (inclusive reconectar)? Fonte desconhecida: não. */
  async hasSource(userId: string, source: string): Promise<boolean> {
    if (source === 'sigaa') return (await this.cofre.cofre(userId)) !== null;
    if (source === 'moodle') return (await this.accountsOf(userId, 'MOODLE')).length > 0;
    if (source === 'classroom') return (await this.accountsOf(userId, 'CLASSROOM')).length > 0;
    if (source === 'siasb') return (await this.siasbLink.status(userId)).state !== 'disconnected';
    return false;
  }

  /** A fonte é oferecida a esta pessoa? Só o SIASB é restrito (matrícula de clínica); as demais são abertas a todos. */
  async hasAccess(userId: string, source: string): Promise<boolean> {
    if (source !== 'siasb') return true;
    return (await this.siasbOf(userId)).offered;
  }

  async sigaaOpens(p: WebPrincipal): Promise<boolean> {
    return (await this.openSigaa(p)) !== null;
  }

  /** Abre a senha do SIGAA do web com a K da sessão (só em memória). `null` se não há ou se a K não abre. */
  async openSigaa(p: WebPrincipal) {
    if (!p.chave || !p.sessionKey) return null;
    try {
      return await this.cofre.abrir(webCopyOf(p), p.chave);
    } catch (e) {
      if (e instanceof CredencialSigaaInvalidaError) return null;
      throw e;
    }
  }

  /** Contas com token guardado (as sem token não servem para ler). */
  async accountsOf(userId: string, provider: 'MOODLE' | 'CLASSROOM'): Promise<SourceAccountRecord[]> {
    return (await this.accounts.findByUserAndProvider(userId, provider)).filter((a) => a.secret !== null);
  }

  async connections(p: WebPrincipal): Promise<Me['connections']> {
    const [sigaa, moodle, classroom, siasb, rows] = await Promise.all([
      this.sigaa(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
      this.siasbDetail(p.userId),
      this.healthRows(p.userId),
    ]);
    const m = moodle[0];
    return {
      sigaa: { ...sigaa, health: sigaaHealth(sigaa.status, sigaa.login ? findRecord(rows, 'SIGAA', `sigaa:${sigaa.login}`) : undefined) },
      siasb: {
        ...siasb.view,
        health: siasbHealth({
          status: siasb.view.status,
          expiresAt: siasb.view.expiresAt ? new Date(siasb.view.expiresAt) : null,
          syncedAt: siasb.view.syncedAt ? new Date(siasb.view.syncedAt) : null,
          syncResult: siasb.syncResult,
          now: this.now(),
        }),
      },
      moodle: m
        ? {
            status: accountStatus(m),
            account: m.accountKey,
            health: accountHealth('AVA', accountStatus(m), findRecord(rows, 'MOODLE', m.accountKey)),
          }
        : { status: 'disconnected', account: null, health: null },
      classroom: {
        available: this.classroom.enabled(),
        apps: this.classroom.apps().map(fromApp),
        accounts: classroom.map((a) => ({
          email: a.accountKey,
          status: accountStatus(a),
          health: accountHealth('Classroom', accountStatus(a), findRecord(rows, 'CLASSROOM', a.accountKey)),
        })),
      },
    };
  }

  /** Resumo por fonte para a tela de autorização. */
  async sources(p: WebPrincipal): Promise<NonNullable<RequestInfo['sources']>> {
    const [sigaa, moodle, classroom, siasb] = await Promise.all([
      this.sigaa(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
      this.siasbOf(p.userId),
    ]);
    const agg = (list: SourceAccountRecord[]) =>
      list.length === 0 ? 'disconnected' : list.some((a) => a.status === 'OK') ? 'connected' : 'reconnect_required';
    const out: NonNullable<RequestInfo['sources']> = [
      { source: 'sigaa', status: sigaa.status },
      { source: 'moodle', status: agg(moodle) },
    ];
    if (this.classroom.enabled()) out.push({ source: 'classroom', status: agg(classroom) });
    // O SIASB só aparece para quem tem acesso a ele (oferta ou conexão); os demais nem sabem que existe.
    if (siasb.offered || siasb.status !== 'disconnected') out.push({ source: 'siasb', status: siasb.status });
    return out;
  }
}
