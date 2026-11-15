import { Logger } from '@nestjs/common';
import { RateWindow } from '../memory/rate-window';
import { randomToken } from '../oauth/pkce';
import { SigaaLoginFormSource, type SigaaLoginForm } from '../ports/sigaa-launch';
import { SourceError } from '../ports/source-gateway';
import type { Secret } from '../shared/secret';
import type { ConnectionStatus } from './connection-status';
import { ApiError, sessionExpired, type WebPrincipal } from './web-api';

/** Quanto vale o token do botão: o clique abre a página na hora. */
export const LAUNCH_TTL_MS = 30_000;
const LAUNCH_PER_WINDOW = 6;
const LAUNCH_WINDOW_MS = 10 * 60_000;

/** O que a página de lançamento precisa para montar o formulário. A senha só sai daqui como `Secret`. */
export interface LaunchForm {
  login: string;
  password: Secret;
  form: SigaaLoginForm;
}

/** Erro da navegação (o resultado é uma página em português, não JSON). */
export class LaunchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  userId: string;
  sessionKey: string;
  expiresAt: number;
}

const audit = new Logger('Audit');

/**
 * Botão "Abrir o SIGAA já logado" (docs/specs: caminho 2 do spike). O painel pede um token de uso único (`create`) e abre
 * `GET /sigaa/launch?t=` numa navegação de página inteira; a API devolve uma página mínima que envia o login ao SIGAA
 * (`redeem`). A senha nunca passa pelo JavaScript do painel: só existe na resposta dessa navegação.
 *
 * - O token é aleatório, vale 30 s, é de uso único e preso à pessoa E à sessão do painel que o pediu.
 * - Premissa: a API roda em UMA instância (como o RateWindow do resto da casa).
 * - Só exige a senha aberta nesta sessão (a K do cookie); nunca loga senha, token ou campo do formulário.
 */
export class SigaaLaunch {
  private readonly pending = new Map<string, Pending>();
  private readonly rate: RateWindow;

  constructor(
    private readonly status: Pick<ConnectionStatus, 'openSigaa'>,
    private readonly loginForm: SigaaLoginFormSource,
    private readonly now: () => number = Date.now,
  ) {
    this.rate = new RateWindow(LAUNCH_PER_WINDOW, LAUNCH_WINDOW_MS, this.now);
  }

  /** O clique do painel: confere que o SIGAA abre nesta sessão e devolve o token. Não toca o SIGAA. */
  async create(p: WebPrincipal): Promise<string> {
    if (!p.sessionKey) throw sessionExpired();
    if (!(await this.status.openSigaa(p))) {
      throw new ApiError(409, 'source_not_connected', 'Conecte ou desbloqueie o SIGAA nesta sessão antes de abri-lo.');
    }
    if (!this.rate.take(p.userId)) {
      throw new ApiError(429, 'too_many_attempts', 'Muitas aberturas do SIGAA em pouco tempo. Tente de novo em alguns minutos.');
    }
    this.sweep();
    const token = randomToken();
    this.pending.set(token, { userId: p.userId, sessionKey: p.sessionKey, expiresAt: this.now() + LAUNCH_TTL_MS });
    return token;
  }

  /** A navegação: gasta o token (uma vez só) e devolve o que monta o formulário. */
  async redeem(p: WebPrincipal, token: string): Promise<LaunchForm> {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    if (!entry || entry.expiresAt < this.now()) throw new LaunchError(410, 'Este link de abertura venceu. Volte ao painel e clique de novo.');
    if (entry.userId !== p.userId || entry.sessionKey !== p.sessionKey) {
      throw new LaunchError(403, 'Este link de abertura não é desta sessão. Volte ao painel e clique de novo.');
    }
    const cred = await this.status.openSigaa(p);
    if (!cred) throw new LaunchError(409, 'Conecte ou desbloqueie o SIGAA no painel antes de abri-lo.');
    let form: SigaaLoginForm;
    try {
      form = await this.loginForm.fetch();
    } catch (e) {
      if (e instanceof SourceError) throw new LaunchError(503, 'O SIGAA não respondeu agora. Tente de novo em instantes.');
      throw e;
    }
    audit.log(`sigaa-launch: user=${p.userId} em=${new Date(this.now()).toISOString()}`);
    return { login: cred.login, password: cred.senha, form };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
  }
}
