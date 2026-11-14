import {
  SigaaSessionExpiredError,
  type SigaaCredentials,
  type SigaaSession,
} from './session';

interface Entrada {
  sessao?: SigaaSession;
  ultimoUso: number;
  /** Cauda da fila da chave; nunca rejeita, para uma falha não travar a próxima chamada. */
  fila: Promise<unknown>;
  pendentes: number;
}

const VINTE_MINUTOS = 20 * 60_000;

/**
 * Sessões do SIGAA só em memória, uma por chave (pessoa + cliente). Chamadas da mesma chave
 * são serializadas; chaves diferentes não se bloqueiam. Não guarda a credencial: ela só passa
 * pelo `login`. Nunca coloca senha nem JSESSIONID em erros.
 */
export class SessoesSigaa {
  private readonly entradas = new Map<string, Entrada>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly criar: () => SigaaSession,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? VINTE_MINUTOS;
    this.now = opts.now ?? Date.now;
  }

  usar<T>(
    chave: string,
    cred: SigaaCredentials,
    fn: (s: SigaaSession) => Promise<T>,
  ): Promise<T> {
    this.podarOciosas();
    let entrada = this.entradas.get(chave);
    if (!entrada) {
      entrada = {
        ultimoUso: this.now(),
        fila: Promise.resolve(),
        pendentes: 0,
      };
      this.entradas.set(chave, entrada);
    }
    const atual = entrada;
    atual.pendentes++;
    const execucao = atual.fila.then(() => this.executar(atual, cred, fn));
    atual.fila = execucao.then(
      () => {
        atual.pendentes--;
      },
      () => {
        atual.pendentes--;
      },
    );
    return execucao;
  }

  esquecer(chave: string): void {
    const entrada = this.entradas.get(chave);
    if (!entrada) return;
    if (entrada.pendentes === 0) this.entradas.delete(chave);
    else entrada.sessao = undefined;
  }

  private async executar<T>(
    entrada: Entrada,
    cred: SigaaCredentials,
    fn: (s: SigaaSession) => Promise<T>,
  ): Promise<T> {
    let sessao = entrada.sessao;
    if (!sessao || this.now() - entrada.ultimoUso > this.ttlMs) {
      sessao = await this.logar(entrada, cred);
    }
    let resultado: T;
    try {
      resultado = await fn(sessao);
    } catch (erro) {
      if (!(erro instanceof SigaaSessionExpiredError)) throw erro;
      sessao = await this.logar(entrada, cred);
      try {
        resultado = await fn(sessao);
      } catch (erro2) {
        if (erro2 instanceof SigaaSessionExpiredError) {
          entrada.sessao = undefined;
        }
        throw erro2;
      }
    }
    entrada.ultimoUso = this.now();
    return resultado;
  }

  private async logar(
    entrada: Entrada,
    cred: SigaaCredentials,
  ): Promise<SigaaSession> {
    entrada.sessao = undefined;
    const sessao = this.criar();
    await sessao.login(cred); // se lançar (inclusive credencial inválida), nada é guardado
    entrada.sessao = sessao;
    entrada.ultimoUso = this.now();
    return sessao;
  }

  /** Remove, ao acessar, entradas paradas além do TTL e sem chamadas em andamento. */
  private podarOciosas(): void {
    const agora = this.now();
    for (const [chave, e] of this.entradas) {
      if (e.pendentes === 0 && agora - e.ultimoUso > this.ttlMs) {
        this.entradas.delete(chave);
      }
    }
  }
}
