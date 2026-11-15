import { Secret } from '../../../application/shared/secret';
import { SecretCipher } from '../../../application/ports/secret-cipher';
import type { SigaaSessionKey, SigaaSessionStore } from '../../../application/ports/repositories';
import {
  SigaaInvalidCredentialsError,
  SigaaSessionExpiredError,
  type SigaaCredentials,
  type SigaaSession,
} from './session';

/** Outra execução da mesma pessoa segura a trava além do tempo de espera. Mensagem fixa, sem dado de ninguém. */
export class SigaaOcupadoError extends Error {
  constructor() {
    super('O SIGAA está ocupado com outra consulta desta conta');
    this.name = 'SigaaOcupadoError';
  }
}

interface Entrada {
  /** Cauda da fila da chave; nunca rejeita, para uma falha não travar a próxima chamada. */
  fila: Promise<unknown>;
  pendentes: number;
}

const MIN = 60_000;

export interface OpcoesSessoesSigaa {
  /** Ocioso além disto, a sessão guardada é descartada e a consulta faz login (o SIGAA expira com ~25 min). */
  ttlMs?: number;
  /** Validade da trava; vence sozinha se o processo morrer. */
  travaMs?: number;
  /** Quanto esperar a trava de outra execução antes de desistir. */
  esperaMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sessão do SIGAA POR PESSOA (login), guardada no store (só o cookie, cifrado) e usada por qualquer cliente.
 *
 * - A senha NÃO entra aqui pronta: `obterCred` abre a senha (com a K do cliente que consulta) só quando é preciso
 *   logar: sessão ausente, parada além do TTL, ou expirada. É o papel de um refresh token.
 * - As consultas da mesma pessoa rodam uma por vez: fila em processo na frente e, atrás, a trava (lease) do store,
 *   que vale entre instâncias (deploys deixam duas rodando por instantes).
 * - Só o cookie é guardado; o ViewState nunca. Cada consulta recomeça pelo portal.
 * - Sessão expirada (formulário de login ou 302 para `expirada.jsp`): reloga uma vez e refaz; expirou de novo: erro.
 * - Nunca coloca senha nem JSESSIONID em erros.
 */
export class SessoesSigaa {
  private readonly entradas = new Map<string, Entrada>();
  private readonly ttlMs: number;
  private readonly travaMs: number;
  private readonly esperaMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly criar: () => SigaaSession,
    private readonly store: SigaaSessionStore,
    private readonly cipher: SecretCipher,
    opts: OpcoesSessoesSigaa = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 20 * MIN;
    this.travaMs = opts.travaMs ?? 2 * MIN;
    this.esperaMs = opts.esperaMs ?? 45_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  usar<T>(
    key: SigaaSessionKey,
    obterCred: () => Promise<SigaaCredentials>,
    fn: (s: SigaaSession) => Promise<T>,
  ): Promise<T> {
    const id = `${key.userId}:${key.login}`;
    let entrada = this.entradas.get(id);
    if (!entrada) {
      entrada = { fila: Promise.resolve(), pendentes: 0 };
      this.entradas.set(id, entrada);
    }
    const atual = entrada;
    atual.pendentes++;
    const execucao = atual.fila.then(() => this.executar(key, obterCred, fn));
    const fim = () => {
      atual.pendentes--;
      if (atual.pendentes === 0) this.entradas.delete(id);
    };
    atual.fila = execucao.then(fim, fim);
    return execucao;
  }

  private async executar<T>(
    key: SigaaSessionKey,
    obterCred: () => Promise<SigaaCredentials>,
    fn: (s: SigaaSession) => Promise<T>,
  ): Promise<T> {
    const token = await this.travar(key);
    try {
      return await this.rodar(key, token, obterCred, fn);
    } finally {
      await this.store.release(key, token).catch(() => undefined);
    }
  }

  private async travar(key: SigaaSessionKey): Promise<string> {
    const limite = this.now() + this.esperaMs;
    let espera = 200;
    for (;;) {
      const token = await this.store.acquire(key, this.travaMs);
      if (token) return token;
      if (this.now() >= limite) throw new SigaaOcupadoError();
      await this.sleep(espera);
      espera = Math.min(espera * 2, 1000);
    }
  }

  private async rodar<T>(
    key: SigaaSessionKey,
    token: string,
    obterCred: () => Promise<SigaaCredentials>,
    fn: (s: SigaaSession) => Promise<T>,
  ): Promise<T> {
    let sessao = this.criar();
    if (!(await this.retomar(key, sessao))) await this.logar(key, token, sessao, obterCred);

    try {
      const resultado = await fn(sessao);
      await this.guardar(key, token, sessao);
      return resultado;
    } catch (erro) {
      if (!(erro instanceof SigaaSessionExpiredError)) {
        await this.guardar(key, token, sessao);
        throw erro;
      }
    }

    // Expirou no meio: um novo login (com a senha aberta pela K de quem consulta) e uma nova tentativa.
    sessao = this.criar();
    await this.logar(key, token, sessao, obterCred);
    try {
      const resultado = await fn(sessao);
      await this.guardar(key, token, sessao);
      return resultado;
    } catch (erro) {
      if (erro instanceof SigaaSessionExpiredError) await this.store.delete(key, token).catch(() => undefined);
      else await this.guardar(key, token, sessao);
      throw erro;
    }
  }

  /** Retoma a sessão guardada se existe, está dentro do TTL e o cookie abre. */
  private async retomar(key: SigaaSessionKey, sessao: SigaaSession): Promise<boolean> {
    const rec = await this.store.load(key);
    if (!rec || this.now() - rec.lastUsedAt > this.ttlMs) return false;
    try {
      sessao.resume(Secret.of(this.cipher.decrypt(rec.cookie)));
      return true;
    } catch {
      return false; // cifrado ilegível (ex.: SECRETS_KEY trocada): trata como sem sessão
    }
  }

  private async logar(
    key: SigaaSessionKey,
    token: string,
    sessao: SigaaSession,
    obterCred: () => Promise<SigaaCredentials>,
  ): Promise<void> {
    try {
      await sessao.login(await obterCred());
    } catch (erro) {
      // Senha recusada: o cookie guardado não serve a ninguém. Outros erros (SIGAA fora) deixam como está.
      if (erro instanceof SigaaInvalidCredentialsError) await this.store.delete(key, token).catch(() => undefined);
      throw erro;
    }
    await this.guardar(key, token, sessao);
  }

  /** Guarda o cookie (pode mudar em qualquer resposta). Melhor esforço: falha ao gravar não derruba a consulta. */
  private async guardar(key: SigaaSessionKey, token: string, sessao: SigaaSession): Promise<void> {
    const cookie = sessao.exportCookie();
    if (!cookie) return;
    try {
      await this.store.save(key, token, { cookie: this.cipher.encrypt(cookie.reveal()), lastUsedAt: this.now() });
    } catch {
      /* próxima consulta loga de novo */
    }
  }
}
