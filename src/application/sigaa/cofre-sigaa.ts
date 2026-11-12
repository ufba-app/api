import { Injectable } from '@nestjs/common';
import { Secret } from '../shared/secret';
import { randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '../ports/repositories';
import { SigaaCredentialRepository } from '../ports/repositories';

export type CifraSigaa = {
  encrypt(s: string): EncryptedSecret;
  decrypt(e: EncryptedSecret): string;
};
export type FabricaCifra = (k: Buffer) => CifraSigaa;

const TTL_TRANSACAO_MS = 15 * 60_000;
const TTL_CODIGO_MS = 5 * 60_000;

export class CredencialSigaaInvalidaError extends Error {
  constructor() {
    super('Credencial do SIGAA inválida: é preciso autenticar novamente.');
    this.name = 'CredencialSigaaInvalidaError';
  }
}

interface Pendente {
  login: string;
  senha: Secret;
  expiresAt: number;
}

/**
 * Guarda a senha do SIGAA cifrada com uma chave K que só o cliente possui (K nunca é persistida).
 * Até o token ser emitido, login+senha ficam apenas em memória, com TTL. Nunca loga senha nem K.
 */
@Injectable()
export class CofreSigaa {
  private readonly porTransacao = new Map<string, Pendente>();
  private readonly porCodigo = new Map<string, Pendente>();

  constructor(
    private readonly repo: SigaaCredentialRepository,
    private readonly cifra: FabricaCifra,
    private readonly now: () => number = Date.now,
  ) {}

  aguardar(txn: string, cred: { login: string; senha: Secret }): void {
    this.limpar();
    this.porTransacao.set(txn, { ...cred, expiresAt: this.now() + TTL_TRANSACAO_MS });
  }

  /** Esquece a senha em espera de uma transação que não chegou ao code (falha ao aprovar). */
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
    this.porCodigo.set(codeHash, { login: p.login, senha: p.senha, expiresAt: this.now() + TTL_CODIGO_MS });
  }

  async gravarNoToken(codeHash: string, quem: { userId: string; clientId: string }): Promise<Buffer | null> {
    this.limpar();
    const p = this.porCodigo.get(codeHash);
    if (!p) return null;
    this.porCodigo.delete(codeHash);
    const k = randomBytes(32);
    const secret = this.cifra(k).encrypt(p.senha.reveal());
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: p.login, secret });
    return k;
  }

  async abrir(
    quem: { userId: string; clientId: string },
    k: Buffer,
  ): Promise<{ login: string; senha: Secret; credencialId: string } | null> {
    const rec = await this.repo.find(quem.userId, quem.clientId);
    if (!rec) return null;
    if (rec.status === 'REAUTH_NEEDED') throw new CredencialSigaaInvalidaError();
    let senha: Secret;
    try {
      senha = Secret.of(this.cifra(k).decrypt(rec.secret));
    } catch {
      // K que não abre o cifrado (ex.: token antigo de uma autorização substituída). Sem detalhe do erro.
      throw new CredencialSigaaInvalidaError();
    }
    return { login: rec.login, senha, credencialId: rec.id };
  }

  /** Login e status da credencial do cliente, sem K e sem decifrar nada (para listar as contas). */
  async situacao(quem: {
    userId: string;
    clientId: string;
  }): Promise<{ login: string; status: 'OK' | 'REAUTH_NEEDED' } | null> {
    const rec = await this.repo.find(quem.userId, quem.clientId);
    return rec ? { login: rec.login, status: rec.status } : null;
  }

  /** Grava direto com uma K que o chamador já tem (a da sessão do app web). Nunca loga senha nem K. */
  async gravar(quem: { userId: string; clientId: string }, cred: { login: string; senha: Secret }, k: Buffer): Promise<void> {
    const secret = this.cifra(k).encrypt(cred.senha.reveal());
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: cred.login, secret });
  }

  async apagar(quem: { userId: string; clientId: string }): Promise<void> {
    await this.repo.delete(quem.userId, quem.clientId);
  }

  async marcarInvalida(credencialId: string): Promise<void> {
    await this.repo.setStatus(credencialId, 'REAUTH_NEEDED');
  }

  private limpar(): void {
    const t = this.now();
    for (const m of [this.porTransacao, this.porCodigo]) {
      for (const [chave, v] of m) if (v.expiresAt <= t) m.delete(chave);
    }
  }
}
