import { Secret } from '../shared/secret';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret, SigaaCredentialRecord } from '../ports/repositories';
import { SigaaCredentialRepository } from '../ports/repositories';
import { CofreSigaa, CredencialSigaaInvalidaError } from './cofre-sigaa';

const SENHA = 'senha-falsa-de-teste-123';
const quem = { userId: 'u1', clientId: 'c1' };

class FakeRepo extends SigaaCredentialRepository {
  upserts: unknown[] = [];
  rec: SigaaCredentialRecord | null = null;
  async upsert(input: { userId: string; clientId: string; login: string; secret: EncryptedSecret }) {
    this.upserts.push(input);
    this.rec = { id: 'cred1', ...input, status: 'OK', createdAt: new Date() };
    return this.rec;
  }
  async find() {
    return this.rec;
  }
  async delete() {
    this.rec = null;
  }
  async setStatus(_id: string, status: 'OK' | 'REAUTH_NEEDED') {
    if (this.rec) this.rec.status = status;
  }
}

// AES-256-GCM equivalente ao AesSecretCipher (a camada application não importa infrastructure, nem em spec).
const cifra = (k: Buffer) => ({
  encrypt(plain: string): EncryptedSecret {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64') };
  },
  decrypt(e: EncryptedSecret): string {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.authTag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]).toString('utf8');
  },
});

function montar() {
  let t = 1_000_000;
  const repo = new FakeRepo();
  const cofre = new CofreSigaa(repo, cifra, () => t);
  return { repo, cofre, avancar: (ms: number) => (t += ms) };
}

async function guardar(cofre: CofreSigaa) {
  cofre.aguardar('txn1', { login: 'aluno', senha: Secret.of(SENHA) });
  cofre.vincularCodigo('txn1', 'hash1');
  return cofre.gravarNoToken('hash1', quem);
}

describe('CofreSigaa', () => {
  it('aguardar → vincularCodigo → gravarNoToken devolve K de 32 bytes e grava só cifrado', async () => {
    const { cofre, repo } = montar();
    expect(cofre.temPendente('txn1')).toBe(false);
    cofre.aguardar('txn1', { login: 'aluno', senha: Secret.of(SENHA) });
    expect(cofre.temPendente('txn1')).toBe(true);
    cofre.vincularCodigo('txn1', 'hash1');
    const k = await cofre.gravarNoToken('hash1', quem);
    expect(k).toHaveLength(32);
    expect(repo.upserts).toHaveLength(1);
    expect(JSON.stringify(repo.upserts[0])).not.toContain(SENHA);
    expect(Buffer.from(repo.rec!.secret.ciphertext, 'base64').toString('utf8')).not.toContain(SENHA);
  });

  it('abrir com a K devolvida recupera login e senha', async () => {
    const { cofre } = montar();
    const k = await guardar(cofre);
    const aberto = await cofre.abrir(quem, k!);
    expect(aberto).toMatchObject({ login: 'aluno', credencialId: 'cred1' });
    expect(aberto!.senha.reveal()).toBe(SENHA);
  });

  it('abrir com outra K falha', async () => {
    const { cofre } = montar();
    await guardar(cofre);
    await expect(cofre.abrir(quem, randomBytes(32))).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
  });

  it('a SECRETS_KEY do servidor não abre o cifrado', async () => {
    const { cofre, repo } = montar();
    await guardar(cofre);
    const servidor = cifra(randomBytes(32)); // a chave do servidor (SECRETS_KEY) não é K
    expect(() => servidor.decrypt(repo.rec!.secret)).toThrow();
  });

  it('pendente expira', async () => {
    const { cofre, avancar } = montar();
    cofre.aguardar('txn1', { login: 'aluno', senha: Secret.of(SENHA) });
    avancar(16 * 60_000);
    expect(cofre.temPendente('txn1')).toBe(false);
    cofre.vincularCodigo('txn1', 'hash1');
    await expect(cofre.gravarNoToken('hash1', quem)).resolves.toBeNull();
  });

  it('código vinculado expira em 5 min', async () => {
    const { cofre, avancar } = montar();
    cofre.aguardar('txn1', { login: 'aluno', senha: Secret.of(SENHA) });
    cofre.vincularCodigo('txn1', 'hash1');
    avancar(6 * 60_000);
    await expect(cofre.gravarNoToken('hash1', quem)).resolves.toBeNull();
  });

  it('gravarNoToken consome o pendente', async () => {
    const { cofre } = montar();
    await guardar(cofre);
    await expect(cofre.gravarNoToken('hash1', quem)).resolves.toBeNull();
  });

  it('abrir devolve null sem credencial e lança se REAUTH_NEEDED', async () => {
    const { cofre } = montar();
    await expect(cofre.abrir(quem, randomBytes(32))).resolves.toBeNull();
    const k = await guardar(cofre);
    await cofre.marcarInvalida('cred1');
    await expect(cofre.abrir(quem, k!)).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
  });

  it('situacao: login e status sem K e sem decifrar', async () => {
    const { cofre } = montar();
    await expect(cofre.situacao(quem)).resolves.toBeNull();
    await guardar(cofre);
    await expect(cofre.situacao(quem)).resolves.toEqual({ login: 'aluno', status: 'OK', credencialId: 'cred1' });
    await cofre.marcarInvalida('cred1');
    await expect(cofre.situacao(quem)).resolves.toEqual({ login: 'aluno', status: 'REAUTH_NEEDED', credencialId: 'cred1' });
  });
});
