import { Injectable } from '@nestjs/common';
import { Secret } from '../shared/secret';
import { randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '../ports/repositories';
import { SigaaCredentialRepository, SigaaVaultRepository } from '../ports/repositories';

export type CifraSigaa = {
  encrypt(s: string): EncryptedSecret;
  decrypt(e: EncryptedSecret): string;
};
export type FabricaCifra = (k: Buffer) => CifraSigaa;

const TTL_TRANSACAO_MS = 15 * 60_000;
const TTL_CODIGO_MS = 5 * 60_000;
export const DK_BYTES = 32;

export class CredencialSigaaInvalidaError extends Error {
  constructor() {
    super('Credencial do SIGAA inválida: é preciso autenticar novamente.');
    this.name = 'CredencialSigaaInvalidaError';
  }
}

interface Pendente {
  login: string;
  /** A DK do cofre, aberta pela sessão do painel que aprovou: vira a cópia do cliente novo no /token. Em `Secret`: `console.log` não imprime. */
  dk: Secret;
  expiresAt: number;
}

/**
 * Cofre da senha do SIGAA (docs/specs/2026-11-15-dk-chave-de-dados.md).
 *
 * - A senha fica cifrada UMA vez por pessoa, com a DK (chave de dados aleatória, nunca guardada em claro): `sigaa_vaults`.
 * - Cada cliente OAuth e cada sessão do painel guarda só uma cópia da DK cifrada com a sua K (que vive só no token):
 *   `sigaa_credentials`. Cada passkey guarda outra, cifrada no navegador com o PRF (`sigaa_master_slots`, opaco aqui).
 * - Trocar a senha recifra só o cofre; as cópias da DK seguem valendo.
 *
 * Até o token ser emitido, login+DK ficam apenas em memória, com TTL. Nunca loga senha, DK nem K.
 */
@Injectable()
export class CofreSigaa {
  private readonly porTransacao = new Map<string, Pendente>();
  private readonly porCodigo = new Map<string, Pendente>();

  constructor(
    private readonly repo: SigaaCredentialRepository,
    private readonly cofres: SigaaVaultRepository,
    private readonly cifra: FabricaCifra,
    private readonly now: () => number = Date.now,
  ) {}

  aguardar(txn: string, cred: { login: string; dk: Secret }): void {
    this.limpar();
    this.porTransacao.set(txn, { login: cred.login, dk: cred.dk, expiresAt: this.now() + TTL_TRANSACAO_MS });
  }

  /** Esquece a DK em espera de uma transação que não chegou ao code (falha ao aprovar). */
  descartar(txn: string): void {
    this.porTransacao.delete(txn);
  }

  temPendente(txn: string): boolean {
    this.limpar();
    return this.porTransacao.has(txn);
  }

  vincularCodigo(txn: string, codeHash: string): void {
    this.limpar();
    const p = this.porTransacao.get(txn);
    if (!p) return;
    this.porTransacao.delete(txn);
    this.porCodigo.set(codeHash, { ...p, expiresAt: this.now() + TTL_CODIGO_MS });
  }

  /** Emite a K do cliente novo e grava a cópia da DK dele. */
  async gravarNoToken(codeHash: string, quem: { userId: string; clientId: string }): Promise<Buffer | null> {
    this.limpar();
    const p = this.porCodigo.get(codeHash);
    if (!p) return null;
    this.porCodigo.delete(codeHash);
    const k = randomBytes(32);
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: p.login, secret: this.embrulhar(Buffer.from(p.dk.reveal(), 'base64url'), k) });
    return k;
  }

  /**
   * Abre a senha com a K do cliente (K → DK → senha). `null` se o cliente não tem cópia ou a pessoa não tem cofre;
   * lança se o cofre pede senha nova ou se a K não abre.
   */
  async abrir(
    quem: { userId: string; clientId: string },
    k: Buffer,
  ): Promise<{ login: string; senha: Secret; credencialId: string; dk: Secret } | null> {
    const rec = await this.repo.find(quem.userId, quem.clientId);
    if (!rec) return null;
    const cofre = await this.cofres.find(quem.userId);
    if (!cofre) return null;
    if (cofre.status === 'REAUTH_NEEDED') throw new CredencialSigaaInvalidaError();
    const dk = this.desembrulhar(rec.secret, k);
    const senha = this.abrirCofre(cofre.secret, dk);
    return { login: cofre.login, senha, credencialId: rec.id, dk: Secret.of(dk.toString('base64url')) };
  }

  /** Login e status do acesso deste cliente, sem K e sem decifrar nada (para listar as contas). */
  async situacao(quem: {
    userId: string;
    clientId: string;
  }): Promise<{ login: string; status: 'OK' | 'REAUTH_NEEDED'; credencialId: string } | null> {
    const rec = await this.repo.find(quem.userId, quem.clientId);
    if (!rec) return null;
    const cofre = await this.cofres.find(quem.userId);
    return cofre ? { login: cofre.login, status: cofre.status, credencialId: rec.id } : null;
  }

  /** O cofre da pessoa existe? (sem K e sem decifrar nada) */
  async cofre(userId: string): Promise<{ login: string; status: 'OK' | 'REAUTH_NEEDED' } | null> {
    const c = await this.cofres.find(userId);
    return c ? { login: c.login, status: c.status } : null;
  }

  /**
   * Grava a senha (a pessoa acabou de provar que é dela) com a K que o chamador já tem (a da sessão do painel).
   * Se esta sessão já abre a DK do cofre, recifra a senha com a MESMA DK (as outras cópias seguem valendo). Senão
   * cria uma DK nova: as cópias dos outros clientes morrem junto (`novaDk: true`) e o chamador apaga as das passkeys.
   */
  async gravar(
    quem: { userId: string; clientId: string },
    cred: { login: string; senha: Secret },
    k: Buffer,
  ): Promise<{ novaDk: boolean }> {
    const dkDaSessao = await this.dkDaSessao(quem, k);
    const dk = dkDaSessao ?? randomBytes(DK_BYTES);
    await this.cofres.upsert({ userId: quem.userId, login: cred.login, secret: this.cifra(dk).encrypt(cred.senha.reveal()) });
    if (!dkDaSessao) await this.repo.deleteAllExcept(quem.userId, quem.clientId);
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: cred.login, secret: this.embrulhar(dk, k) });
    return { novaDk: !dkDaSessao };
  }

  /**
   * Desbloqueio: o navegador trouxe a DK (da passkey ou do pacote do QR). Se ela abre o cofre, esta sessão ganha a
   * sua cópia da DK (com a K dela). Lança se a pessoa não tem cofre ou se a DK não abre.
   */
  async desbloquear(quem: { userId: string; clientId: string }, k: Buffer, dkSecreta: Secret): Promise<void> {
    const cofre = await this.cofres.find(quem.userId);
    if (!cofre) throw new CredencialSigaaInvalidaError();
    const dk = Buffer.from(dkSecreta.reveal(), 'base64url');
    if (dk.length !== DK_BYTES) throw new CredencialSigaaInvalidaError();
    this.abrirCofre(cofre.secret, dk); // lança se não abre
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: cofre.login, secret: this.embrulhar(dk, k) });
  }

  /** A DK do cofre, aberta com a K desta sessão (para o navegador cifrá-la com a passkey). `null` se não abre. */
  async chaveDeDados(quem: { userId: string; clientId: string }, k: Buffer): Promise<Secret | null> {
    const dk = await this.dkDaSessao(quem, k);
    return dk ? Secret.of(dk.toString('base64url')) : null;
  }

  /** Apaga só a cópia da DK deste cliente/sessão. O cofre e as cópias dos outros ficam. */
  async apagar(quem: { userId: string; clientId: string }): Promise<void> {
    await this.repo.delete(quem.userId, quem.clientId);
  }

  /** A pessoa quis tirar a senha: apaga o cofre e todas as cópias da DK. */
  async apagarCofre(userId: string): Promise<void> {
    await this.cofres.delete(userId);
    await this.repo.deleteAllOf(userId);
  }

  /** O SIGAA recusou esta senha: vale para todos os clientes até a pessoa digitar a nova. */
  async marcarInvalida(userId: string): Promise<void> {
    await this.cofres.setStatus(userId, 'REAUTH_NEEDED');
  }

  // ---- internos ----

  private embrulhar(dk: Buffer, k: Buffer): EncryptedSecret {
    return this.cifra(k).encrypt(dk.toString('base64url'));
  }

  /** Abre a cópia da DK com a K. Qualquer falha vira "inválida", sem detalhe do erro. */
  private desembrulhar(secret: EncryptedSecret, k: Buffer): Buffer {
    let dk: Buffer;
    try {
      dk = Buffer.from(this.cifra(k).decrypt(secret), 'base64url');
    } catch {
      throw new CredencialSigaaInvalidaError();
    }
    if (dk.length !== DK_BYTES) throw new CredencialSigaaInvalidaError();
    return dk;
  }

  private abrirCofre(secret: EncryptedSecret, dk: Buffer): Secret {
    try {
      return Secret.of(this.cifra(dk).decrypt(secret));
    } catch {
      throw new CredencialSigaaInvalidaError();
    }
  }

  /** A DK que esta K abre E que abre o cofre atual; `null` se não há cópia, cofre, ou nada confere. */
  private async dkDaSessao(quem: { userId: string; clientId: string }, k: Buffer): Promise<Buffer | null> {
    const [rec, cofre] = await Promise.all([this.repo.find(quem.userId, quem.clientId), this.cofres.find(quem.userId)]);
    if (!rec || !cofre) return null;
    try {
      const dk = this.desembrulhar(rec.secret, k);
      this.abrirCofre(cofre.secret, dk);
      return dk;
    } catch {
      return null;
    }
  }

  private limpar(): void {
    const t = this.now();
    for (const m of [this.porTransacao, this.porCodigo]) {
      for (const [chave, v] of m) if (v.expiresAt <= t) m.delete(chave);
    }
  }
}
