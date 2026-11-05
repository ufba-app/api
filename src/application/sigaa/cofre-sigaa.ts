import { Injectable } from '@nestjs/common';
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
  senha: string;
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

  aguardar(txn: string, cred: { login: string; senha: string }): void {
    this.limpar();
    this.porTransacao.set(txn, { ...cred, expiresAt: this.now() + TTL_TRANSACAO_MS });
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
    const secret = this.cifra(k).encrypt(p.senha);
    await this.repo.upsert({ userId: quem.userId, clientId: quem.clientId, login: p.login, secret });
    return k;
  }

  async abrir(
    quem: { userId: string; clientId: string },
    k: Buffer,
  ): Promise<{ login: string; senha: string; credencialId: string } | null> {
    const rec = await this.repo.find(quem.userId, quem.clientId);
    if (!rec) return null;
    if (rec.status === 'REAUTH_NEEDED') throw new CredencialSigaaInvalidaError();
    const senha = this.cifra(k).decrypt(rec.secret);
    return { login: rec.login, senha, credencialId: rec.id };
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
