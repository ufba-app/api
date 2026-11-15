import { moodleBelongsTo, moodleSubject, sigaaSubject } from '../../domain/identity/source-binding';
import type { IdentityService } from '../identity/identity.service';
import type { SourceBindings } from '../identity/source-bindings';
import {
  LinkError,
  type AppClassroom,
  type ClassroomLinkPort,
  type MoodleLinkPort,
  type SigaaLinkPort,
  type UserDirectory,
} from '../oauth/oauth-ports';
import { randomToken } from '../oauth/pkce';
import type { SigaaMasterSlotRepository, SourceAccountRepository } from '../ports/repositories';
import { Secret } from '../shared/secret';
import type { CofreSigaa } from '../sigaa/cofre-sigaa';
import { ApiError, sessionExpired, WEB_CLIENT_ID, type GuestApp, type WebPrincipal } from './web-api';

const STATE_TTL_MS = 10 * 60 * 1000;
const toApp = (a: GuestApp): AppClassroom => (a === 'guest' ? 'convidado' : 'ufba');

/**
 * Conectar e desconectar as fontes da pessoa (SIGAA, Moodle, Classroom). As contas são da pessoa e ficam ligadas a
 * ela pelo vínculo fixo (domain/identity/source-binding).
 */
export class ConnectionsService {
  /** `state` do Google para conectar o Classroom pelo web: aleatório, de uso único, preso à pessoa. */
  private readonly classroomStates = new Map<string, { userId: string; app: AppClassroom; expiresAt: number }>();

  constructor(
    private readonly users: UserDirectory,
    private readonly cofre: CofreSigaa,
    private readonly sigaa: SigaaLinkPort,
    private readonly moodle: MoodleLinkPort,
    private readonly classroom: ClassroomLinkPort,
    private readonly accounts: SourceAccountRepository,
    private readonly identity: IdentityService,
    private readonly bindings: SourceBindings,
    private readonly slots: SigaaMasterSlotRepository,
    private readonly cfg: { webOrigin: string; institutionalDomain: string },
    private readonly now: () => number = Date.now,
  ) {}

  // ---- SIGAA ----

  async connectSigaa(p: WebPrincipal, body: { login?: unknown; password?: unknown }): Promise<void> {
    if (!p.chave) throw sessionExpired();
    const login = typeof body.login === 'string' ? body.login : '';
    const password = Secret.of(typeof body.password === 'string' ? body.password : '');
    // Conta já ligada a outro CPF: recusa antes de falar com o SIGAA (não gasta tentativa nem revela nada de ninguém).
    await this.bindings.assertCompatible(p.userId, sigaaSubject(login));
    let usuario: string;
    try {
      usuario = await this.sigaa.validar(`web:${p.userId}`, login, password, p.userId);
    } catch (e) {
      // O SIGAA recusou a senha: a cópia mestra (passkey) guarda uma senha que não vale mais (ex.: trocada no SIGAA).
      // Descarta, para o desbloqueio não tentar de novo a senha velha a cada login (e bloquear a conta no SIGAA).
      if (e instanceof LinkError && e.code === 'invalid_credentials') await this.slots.deleteAll(p.userId);
      throw e;
    }
    // Senha certa provou que o CPF é desta pessoa: só agora o vínculo (e a recusa se o CPF for de outra conta).
    await this.bindings.bind(p.userId, sigaaSubject(usuario));
    await this.cofre.gravar({ userId: p.userId, clientId: WEB_CLIENT_ID }, { login: usuario, senha: password }, p.chave);
  }

  async disconnectSigaa(p: WebPrincipal): Promise<void> {
    await this.cofre.apagar({ userId: p.userId, clientId: WEB_CLIENT_ID });
    // A pessoa quis tirar a senha: a cópia mestra (passkey) também vai.
    await this.slots.deleteAll(p.userId);
  }

  // ---- Moodle ----

  async moodleStart(p: WebPrincipal): Promise<{ launchUrl: string; scheme: string }> {
    return { launchUrl: await this.moodle.launchUrl(p.userId, 'web'), scheme: this.moodle.scheme() };
  }

  async connectMoodle(p: WebPrincipal, body: { link?: unknown }): Promise<void> {
    const acc = await this.moodle.verify(p.userId, 'web', typeof body.link === 'string' ? body.link : '');
    const profile = await this.users.findProfile(p.userId);
    if (!profile?.email || !moodleBelongsTo({ auth: acc.auth, username: acc.username }, profile.email, this.cfg.institutionalDomain)) {
      throw new LinkError(
        `Essa conta do AVA não é a sua. Entre no AVA com o login institucional de ${profile?.email ?? 'sua conta'} e tente de novo.`,
        'source_account_not_owned',
      );
    }
    await this.bindings.bind(p.userId, moodleSubject(acc.host, acc.moodleUserId));
    await this.identity.conectarConta({
      userId: p.userId,
      provider: 'MOODLE',
      accountKey: `${acc.host}:${acc.username}`,
      siteUrl: acc.siteUrl,
      secretPlain: acc.token,
    });
  }

  async disconnectMoodle(p: WebPrincipal): Promise<void> {
    for (const a of await this.accounts.findByUserAndProvider(p.userId, 'MOODLE')) await this.accounts.delete(a.id);
  }

  // ---- Classroom ----

  /** URL do Google para conectar uma conta; `callbackBase` = URL pública da API. */
  async classroomStart(p: WebPrincipal, app: unknown, callbackBase: string): Promise<string> {
    const qual: GuestApp = app === 'guest' ? 'guest' : 'ufba';
    const interno = toApp(qual);
    if (!this.classroom.apps().includes(interno)) {
      throw new ApiError(501, 'not_supported', 'Esse tipo de conta do Classroom não está disponível neste servidor.');
    }
    this.pruneStates();
    const state = `web.${randomToken()}`;
    this.classroomStates.set(state, { userId: p.userId, app: interno, expiresAt: this.now() + STATE_TTL_MS });
    return this.classroom.startUrl(interno, classroomCallback(callbackBase, interno), state);
  }

  isWebState(state: unknown): state is string {
    return typeof state === 'string' && state.startsWith('web.');
  }

  /**
   * Volta do Google (Classroom pelo web). O `state` precisa ser desta pessoa E o cookie de sessão da mesma pessoa
   * (senão alguém poderia ligar a conta dele na sessão de outro). Devolve para onde mandar o navegador.
   */
  async classroomCallback(
    q: { state: string; code?: string; error?: string },
    sessionUserId: string | undefined,
    callbackBase: string,
  ): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.cfg.webOrigin.replace(/\/+$/, '')}/connections?${new URLSearchParams(params).toString()}`;
    this.pruneStates();
    const st = this.classroomStates.get(q.state);
    this.classroomStates.delete(q.state);
    if (!st || !sessionUserId || st.userId !== sessionUserId) {
      return back({ error: 'invalid_request', message: 'O pedido de conexão expirou. Tente de novo.' });
    }
    if (q.error || !q.code) {
      return back({ error: 'access_denied', message: 'Conexão com o Classroom cancelada na tela do Google.' });
    }
    try {
      await this.classroom.handleCallback(st.app, st.userId, q.code, classroomCallback(callbackBase, st.app));
      return back({ connected: 'classroom' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao conectar o Classroom.';
      return back({ error: 'source_unavailable', message: msg });
    }
  }

  async disconnectClassroom(p: WebPrincipal, email: string): Promise<void> {
    const alvo = email.trim().toLowerCase();
    const contas = (await this.accounts.findByUserAndProvider(p.userId, 'CLASSROOM')).filter(
      (a) => a.accountKey.toLowerCase() === alvo,
    );
    if (contas.length === 0) throw new ApiError(404, 'not_found', 'Essa conta do Classroom não está conectada.');
    for (const a of contas) await this.accounts.delete(a.id);
  }

  private pruneStates(): void {
    const t = this.now();
    for (const [k, v] of this.classroomStates) if (v.expiresAt <= t) this.classroomStates.delete(k);
  }
}

function classroomCallback(base: string, app: AppClassroom): string {
  return `${base.replace(/\/+$/, '')}/oauth/callback/${app === 'ufba' ? 'google' : 'classroom'}`;
}
