import type { ClassroomLinkPort } from '../oauth/oauth-ports';
import type { SigaaMasterSlotRepository, SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import { CofreSigaa, CredencialSigaaInvalidaError } from '../sigaa/cofre-sigaa';
import { WEB_CLIENT_ID, type AccountStatus, type GuestApp, type Me, type RequestInfo, type WebPrincipal } from './web-api';

export const accountStatus = (a: SourceAccountRecord): AccountStatus =>
  a.status === 'OK' ? 'connected' : 'reconnect_required';
export const fromApp = (a: 'ufba' | 'convidado'): GuestApp => (a === 'convidado' ? 'guest' : 'ufba');

/**
 * Estado das conexões de quem está logado no web (lido por /me, pela tela de autorização e ao sair). A senha do
 * SIGAA do web só abre com a K da sessão: "conectado" quer dizer "esta sessão consegue usar".
 */
export class ConnectionStatus {
  constructor(
    private readonly cofre: CofreSigaa,
    private readonly accounts: SourceAccountRepository,
    private readonly classroom: ClassroomLinkPort,
    private readonly slots: SigaaMasterSlotRepository,
  ) {}

  async sigaa(p: WebPrincipal): Promise<Me['connections']['sigaa']> {
    const slots = await this.slots.count(p.userId);
    const passkey = { slots };
    const rec = await this.cofre.situacao({ userId: p.userId, clientId: WEB_CLIENT_ID });
    // `locked`: não há senha utilizável nesta sessão, mas existe cópia mestra (um toque na passkey religa).
    if (!rec) return { status: slots > 0 ? 'locked' : 'disconnected', login: null, passkey };
    if (rec.status !== 'OK') return { status: 'password_required', login: rec.login, passkey };
    if (!(await this.sigaaOpens(p))) return { status: slots > 0 ? 'locked' : 'password_required', login: rec.login, passkey };
    return { status: 'connected', login: rec.login, passkey };
  }

  async sigaaOpens(p: WebPrincipal): Promise<boolean> {
    return (await this.openSigaa(p)) !== null;
  }

  /** Abre a senha do SIGAA do web com a K da sessão (só em memória). `null` se não há ou se a K não abre. */
  async openSigaa(p: WebPrincipal) {
    if (!p.chave) return null;
    try {
      return await this.cofre.abrir({ userId: p.userId, clientId: WEB_CLIENT_ID }, p.chave);
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
    const [sigaa, moodle, classroom] = await Promise.all([
      this.sigaa(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
    ]);
    const m = moodle[0];
    return {
      sigaa,
      moodle: m ? { status: accountStatus(m), account: m.accountKey } : { status: 'disconnected', account: null },
      classroom: {
        available: this.classroom.enabled(),
        apps: this.classroom.apps().map(fromApp),
        accounts: classroom.map((a) => ({ email: a.accountKey, status: accountStatus(a) })),
      },
    };
  }

  /** Resumo por fonte para a tela de autorização. */
  async sources(p: WebPrincipal): Promise<NonNullable<RequestInfo['sources']>> {
    const [sigaa, moodle, classroom] = await Promise.all([
      this.sigaa(p),
      this.accountsOf(p.userId, 'MOODLE'),
      this.accountsOf(p.userId, 'CLASSROOM'),
    ]);
    const agg = (list: SourceAccountRecord[]) =>
      list.length === 0 ? 'disconnected' : list.some((a) => a.status === 'OK') ? 'connected' : 'reconnect_required';
    const out: NonNullable<RequestInfo['sources']> = [
      { source: 'sigaa', status: sigaa.status },
      { source: 'moodle', status: agg(moodle) },
    ];
    if (this.classroom.enabled()) out.push({ source: 'classroom', status: agg(classroom) });
    return out;
  }
}
