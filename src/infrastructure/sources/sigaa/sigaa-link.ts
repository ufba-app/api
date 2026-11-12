import type { Secret } from '../../../application/shared/secret';
import { LinkError, type SigaaLinkPort } from '../../../application/oauth/oauth-ports';
import type { CofreSigaa } from '../../../application/sigaa/cofre-sigaa';
import { createSigaaHttpClient, type SigaaHttpClient } from './http-client';
import { SigaaInvalidCredentialsError, SigaaSession } from './session';

export class SigaaLinkError extends LinkError {}

const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

/** Janela das tentativas erradas (por transação, por usuário e por login do SIGAA). */
const JANELA_MS = 15 * 60 * 1000;
const MAX_POR_TXN = 3;
const MAX_POR_USUARIO = 5;
const MAX_POR_LOGIN = 5;
const MUITAS_TENTATIVAS = 'Muitas tentativas. Volte ao aplicativo e inicie a autorização de novo.';

interface Contador {
  /** Senhas erradas dentro da janela. */
  falhas: number;
  /** Tentativas ainda falando com o SIGAA: contam no limite até terminarem. */
  emAndamento: number;
  expiraEm: number;
}

type Limite = { mapa: Map<string, Contador>; chave: string; max: number };

/**
 * Vínculo do SIGAA na tela de /authorize: valida login e senha com 1 login real + 1 GET do portal e, se passar,
 * entrega ao cofre (memória, com TTL) até o /token. A senha nunca entra em mensagem de erro nem em log.
 *
 * Para não virar um oráculo de adivinhar senhas do SIGAA através do servidor, conta as senhas ERRADAS (só
 * `SigaaInvalidCredentialsError`; SIGAA fora do ar não conta) em três chaves, numa janela de 15 min:
 * - por transação (3) e por usuário do serviço (5): freiam quem testa senhas;
 * - por login do SIGAA (5): o alvo. Trocar de transação ou de conta Google não reinicia esse contador.
 *
 * A tentativa é RESERVADA antes de falar com o SIGAA (sem nenhum `await` entre a checagem e a reserva), então
 * requisições paralelas não passam todas pela checagem antes da primeira falha ser contada. Passado o limite,
 * recusa sem falar com o SIGAA. Contadores em memória (por instância), podados a cada chamada.
 *
 * Efeito colateral aceito: 5 senhas erradas para um login bloqueiam a conexão desse login por até 15 min,
 * inclusive para o dono. Melhor que deixar o serviço ser usado para adivinhar a senha dele.
 */
export class SigaaLink implements SigaaLinkPort {
  private readonly porTxn = new Map<string, Contador>();
  private readonly porUsuario = new Map<string, Contador>();
  private readonly porLogin = new Map<string, Contador>();

  constructor(
    private readonly cofre: CofreSigaa,
    private readonly http: SigaaHttpClient = createSigaaHttpClient(),
    private readonly now: () => number = Date.now,
  ) {}

  async conectar(txn: string, login: string, senha: Secret, userId: string): Promise<void> {
    const usuario = await this.validar(txn, login, senha, userId);
    this.cofre.aguardar(txn, { login: usuario, senha });
  }

  /** `txn`: a transação da tela de /authorize, ou outra chave estável do pedido (ex.: a sessão do app web). */
  async validar(txn: string, login: string, senha: Secret, userId: string): Promise<string> {
    const usuario = login.trim();
    if (!usuario || senha.isEmpty()) throw new SigaaLinkError('Informe o usuário e a senha do SIGAA.', 'invalid_request');
    const agora = this.now();
    this.podar(agora);

    const limites: Limite[] = [
      { mapa: this.porTxn, chave: txn, max: MAX_POR_TXN },
      { mapa: this.porUsuario, chave: userId, max: MAX_POR_USUARIO },
      { mapa: this.porLogin, chave: usuario.toLowerCase(), max: MAX_POR_LOGIN },
    ];
    if (limites.some(({ mapa, chave, max }) => ocupado(mapa.get(chave)) >= max)) {
      throw new SigaaLinkError(MUITAS_TENTATIVAS, 'too_many_attempts');
    }
    const contadores = limites.map(({ mapa, chave }) => reservar(mapa, chave, agora));

    let ok = false;
    try {
      const session = new SigaaSession(this.http);
      await session.login({ login: usuario, password: senha });
      await session.get(PORTAL_HOME_PATH);
      ok = true;
    } catch (e) {
      if (e instanceof SigaaInvalidCredentialsError) {
        for (const c of contadores) c.falhas += 1;
        throw new SigaaLinkError('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
      }
      throw new SigaaLinkError('Não consegui falar com o SIGAA agora. Tente de novo em instantes.', 'source_unavailable');
    } finally {
      for (const c of contadores) c.emAndamento -= 1;
      if (ok) {
        // Senha certa prova o dono: zera a transação e o login. O contador do usuário fica (freia quem testa
        // senhas de outros e no meio entra com a própria).
        this.porTxn.delete(txn);
        this.porLogin.delete(usuario.toLowerCase());
      }
    }
    return usuario;
  }

  pendente(txn: string): boolean {
    return this.cofre.temPendente(txn);
  }

  private podar(agora: number): void {
    for (const mapa of [this.porTxn, this.porUsuario, this.porLogin]) {
      for (const [chave, c] of mapa) if (c.expiraEm <= agora && c.emAndamento === 0) mapa.delete(chave);
    }
  }
}

function ocupado(c: Contador | undefined): number {
  return c ? c.falhas + c.emAndamento : 0;
}

function reservar(mapa: Map<string, Contador>, chave: string, agora: number): Contador {
  let c = mapa.get(chave);
  if (!c) {
    c = { falhas: 0, emAndamento: 0, expiraEm: agora + JANELA_MS };
    mapa.set(chave, c);
  }
  c.emAndamento += 1;
  return c;
}
