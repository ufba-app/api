import type { SigaaLinkPort } from '../../../application/oauth/oauth-ports';
import type { CofreSigaa } from '../../../application/sigaa/cofre-sigaa';
import { createSigaaHttpClient, type SigaaHttpClient } from './http-client';
import { SigaaInvalidCredentialsError, SigaaSession } from './session';

export class SigaaLinkError extends Error {}

const PORTAL_HOME_PATH = '/sigaa/portais/discente/discente.jsf';

/** Janela das tentativas erradas (por transação e por usuário). */
const JANELA_MS = 15 * 60 * 1000;
const MAX_FALHAS_POR_TXN = 3;
const MAX_FALHAS_POR_USUARIO = 5;
const MUITAS_TENTATIVAS = 'Muitas tentativas. Volte ao aplicativo e inicie a autorização de novo.';

interface Falhas {
  quantas: number;
  expiraEm: number;
}

/**
 * Vínculo do SIGAA na tela de /authorize: valida login e senha com 1 login real + 1 GET do portal e, se passar,
 * entrega ao cofre (memória, com TTL) até o /token. A senha nunca entra em mensagem de erro nem em log.
 *
 * Para não virar um oráculo de adivinhar senhas do SIGAA através do servidor, conta as senhas ERRADAS (só
 * `SigaaInvalidCredentialsError`; SIGAA fora do ar não conta): no máximo 3 por transação e 5 por usuário em 15 min.
 * Passado o limite, recusa sem falar com o SIGAA. Contadores em memória, expiram e são podados a cada chamada.
 */
export class SigaaLink implements SigaaLinkPort {
  private readonly falhasPorTxn = new Map<string, Falhas>();
  private readonly falhasPorUsuario = new Map<string, Falhas>();

  constructor(
    private readonly cofre: CofreSigaa,
    private readonly http: SigaaHttpClient = createSigaaHttpClient(),
    private readonly now: () => number = Date.now,
  ) {}

  async conectar(txn: string, login: string, senha: string, userId: string): Promise<void> {
    const usuario = login.trim();
    if (!usuario || !senha) throw new SigaaLinkError('Informe o usuário e a senha do SIGAA.');
    const agora = this.now();
    this.podar(agora);
    if (
      (this.falhasPorTxn.get(txn)?.quantas ?? 0) >= MAX_FALHAS_POR_TXN ||
      (this.falhasPorUsuario.get(userId)?.quantas ?? 0) >= MAX_FALHAS_POR_USUARIO
    ) {
      throw new SigaaLinkError(MUITAS_TENTATIVAS);
    }
    try {
      const session = new SigaaSession(this.http);
      await session.login({ login: usuario, password: senha });
      await session.get(PORTAL_HOME_PATH);
    } catch (e) {
      if (e instanceof SigaaInvalidCredentialsError) {
        this.contarFalha(this.falhasPorTxn, txn, agora);
        this.contarFalha(this.falhasPorUsuario, userId, agora);
        throw new SigaaLinkError('Não foi possível entrar: usuário ou senha do SIGAA incorretos.');
      }
      throw new SigaaLinkError('Não consegui falar com o SIGAA agora. Tente de novo em instantes.');
    }
    this.falhasPorTxn.delete(txn);
    this.cofre.aguardar(txn, { login: usuario, senha });
  }

  pendente(txn: string): boolean {
    return this.cofre.temPendente(txn);
  }

  private contarFalha(mapa: Map<string, Falhas>, chave: string, agora: number): void {
    const atual = mapa.get(chave);
    if (atual) atual.quantas += 1;
    else mapa.set(chave, { quantas: 1, expiraEm: agora + JANELA_MS });
  }

  private podar(agora: number): void {
    for (const mapa of [this.falhasPorTxn, this.falhasPorUsuario]) {
      for (const [chave, f] of mapa) if (f.expiraEm <= agora) mapa.delete(chave);
    }
  }
}
