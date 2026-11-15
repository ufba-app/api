import { randomBytes } from 'node:crypto';
import { Secret } from '../shared/secret';
import { CofreSigaa, CredencialSigaaInvalidaError } from './cofre-sigaa';
import { InMemoryCredentials, InMemoryVaults, cifraDeTeste as cifra } from '../../../test/support/sigaa-store-fake';

const SENHA = 'senha-falsa-de-teste-123';
const NOVA_SENHA = 'outra-senha-falsa-456';
const quem = { userId: 'u1', clientId: 'c1' };
const web = { userId: 'u1', clientId: 'ufba-web' };

function montar() {
  let t = 1_000_000;
  const repo = new InMemoryCredentials();
  const cofres = new InMemoryVaults();
  const cofre = new CofreSigaa(repo, cofres, cifra, () => t);
  return { repo, cofres, cofre, avancar: (ms: number) => (t += ms) };
}

/** O painel conecta: cria o cofre e a cópia da DK da sessão (K do painel). */
async function conectar(cofre: CofreSigaa, senha = SENHA) {
  const kWeb = randomBytes(32);
  await cofre.gravar(web, { login: 'aluno', senha: Secret.of(senha) }, kWeb);
  return kWeb;
}

/** O painel autoriza um app: a DK aberta pela sessão vai para o cliente novo, que ganha a sua K no /token. */
async function autorizar(cofre: CofreSigaa, kWeb: Buffer, txn = 'txn1', hash = 'hash1') {
  const aberta = await cofre.abrir(web, kWeb);
  cofre.aguardar(txn, { login: aberta!.login, dk: aberta!.dk });
  cofre.vincularCodigo(txn, hash);
  return cofre.gravarNoToken(hash, quem);
}

describe('CofreSigaa (cofre com DK)', () => {
  it('conectar grava a senha cifrada no cofre e só a DK cifrada na cópia da sessão; nada em claro', async () => {
    const { cofre, repo, cofres } = montar();
    const k = await conectar(cofre);
    const v = cofres.rows.get('u1')!;
    expect(JSON.stringify(v)).not.toContain(SENHA);
    expect(Buffer.from(v.secret.ciphertext, 'base64').toString('utf8')).not.toContain(SENHA);
    const cop = repo.rows.get('u1|ufba-web')!;
    expect(JSON.stringify(cop)).not.toContain(SENHA);
    // A cópia é a DK (32 bytes) cifrada com a K: aberta com a K, dá 43 caracteres base64url.
    expect(Buffer.from(cifra(k).decrypt(cop.secret, 'copy:u1:ufba-web'), 'base64url')).toHaveLength(32);
  });

  it('abrir com a K da sessão recupera login, senha e a DK', async () => {
    const { cofre } = montar();
    const k = await conectar(cofre);
    const a = await cofre.abrir(web, k);
    expect(a).toMatchObject({ login: 'aluno' });
    expect(a!.senha.reveal()).toBe(SENHA);
    expect(Buffer.from(a!.dk.reveal(), 'base64url')).toHaveLength(32);
  });

  it('autorizar um app: o cliente recebe uma K de 32 bytes e abre a mesma senha', async () => {
    const { cofre } = montar();
    const kWeb = await conectar(cofre);
    const k = await autorizar(cofre, kWeb);
    expect(k).toHaveLength(32);
    expect((await cofre.abrir(quem, k!))!.senha.reveal()).toBe(SENHA);
  });

  it('K errada não abre; a SECRETS_KEY do servidor não abre a cópia da DK nem o cofre', async () => {
    const { cofre, repo, cofres } = montar();
    await conectar(cofre);
    await expect(cofre.abrir(web, randomBytes(32))).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    const servidor = cifra(randomBytes(32));
    expect(() => servidor.decrypt(repo.rows.get('u1|ufba-web')!.secret)).toThrow();
    expect(() => servidor.decrypt(cofres.rows.get('u1')!.secret)).toThrow();
  });

  it('trocar a senha com a DK da sessão recifra só o cofre: o app já autorizado segue abrindo, com a senha nova', async () => {
    const { cofre, cofres } = montar();
    const kWeb = await conectar(cofre);
    const kApp = (await autorizar(cofre, kWeb))!;
    const r = await cofre.gravar(web, { login: 'aluno', senha: Secret.of(NOVA_SENHA) }, kWeb);
    expect(r.novaDk).toBe(false);
    expect(cofres.rows.get('u1')!.version).toBe(2);
    expect((await cofre.abrir(quem, kApp))!.senha.reveal()).toBe(NOVA_SENHA);
    expect((await cofre.abrir(web, kWeb))!.senha.reveal()).toBe(NOVA_SENHA);
  });

  it('senha digitada numa sessão sem a DK cria DK nova e derruba as cópias dos outros clientes', async () => {
    const { cofre, repo } = montar();
    const kWeb = await conectar(cofre);
    const kApp = (await autorizar(cofre, kWeb))!;
    const kWebNova = randomBytes(32); // outra sessão do painel, sem cópia da DK
    const r = await cofre.gravar(web, { login: 'aluno', senha: Secret.of(NOVA_SENHA) }, kWebNova);
    expect(r.novaDk).toBe(true);
    expect(repo.rows.has('u1|c1')).toBe(false); // o app perdeu a cópia
    await expect(cofre.abrir(quem, kApp)).resolves.toBeNull();
    expect((await cofre.abrir(web, kWebNova))!.senha.reveal()).toBe(NOVA_SENHA);
  });

  it('desbloquear com a DK certa dá à sessão nova uma cópia; DK errada ou sem cofre falha', async () => {
    const { cofre } = montar();
    const kWeb = await conectar(cofre);
    const dk = (await cofre.chaveDeDados(web, kWeb))!;
    expect(Buffer.from(dk.reveal(), 'base64url')).toHaveLength(32);
    await cofre.apagar(web); // sair
    const kNova = randomBytes(32);
    const s = (b: Buffer) => Secret.of(b.toString('base64url'));
    await expect(cofre.desbloquear(web, kNova, s(randomBytes(32)))).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    await expect(cofre.desbloquear(web, kNova, s(Buffer.alloc(5)))).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    await cofre.desbloquear(web, kNova, dk);
    expect((await cofre.abrir(web, kNova))!.senha.reveal()).toBe(SENHA);
    await expect(cofre.desbloquear({ userId: 'outro', clientId: 'ufba-web' }, kNova, dk)).rejects.toBeInstanceOf(
      CredencialSigaaInvalidaError,
    );
  });

  it('sair (apagar) tira só a cópia da sessão: o cofre e a cópia do app ficam', async () => {
    const { cofre } = montar();
    const kWeb = await conectar(cofre);
    const kApp = (await autorizar(cofre, kWeb))!;
    await cofre.apagar(web);
    await expect(cofre.cofre('u1')).resolves.toEqual({ login: 'aluno', status: 'OK' });
    await expect(cofre.abrir(web, kWeb)).resolves.toBeNull();
    expect((await cofre.abrir(quem, kApp))!.senha.reveal()).toBe(SENHA);
  });

  it('apagarCofre tira o cofre e todas as cópias', async () => {
    const { cofre } = montar();
    const kWeb = await conectar(cofre);
    const kApp = (await autorizar(cofre, kWeb))!;
    await cofre.apagarCofre('u1');
    await expect(cofre.cofre('u1')).resolves.toBeNull();
    await expect(cofre.abrir(web, kWeb)).resolves.toBeNull();
    await expect(cofre.abrir(quem, kApp)).resolves.toBeNull();
  });

  it('marcarInvalida vale para todos os clientes; digitar a senha nova limpa a marca', async () => {
    const { cofre } = montar();
    const kWeb = await conectar(cofre);
    const kApp = (await autorizar(cofre, kWeb))!;
    await cofre.marcarInvalida('u1');
    await expect(cofre.abrir(quem, kApp)).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    await expect(cofre.abrir(web, kWeb)).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    await expect(cofre.situacao(quem)).resolves.toMatchObject({ status: 'REAUTH_NEEDED' });
    await cofre.gravar(web, { login: 'aluno', senha: Secret.of(NOVA_SENHA) }, kWeb); // a sessão ainda tem a DK
    expect((await cofre.abrir(quem, kApp))!.senha.reveal()).toBe(NOVA_SENHA);
  });

  it('situacao: login e status sem K e sem decifrar nada', async () => {
    const { cofre } = montar();
    await expect(cofre.situacao(web)).resolves.toBeNull();
    await conectar(cofre);
    await expect(cofre.situacao(web)).resolves.toMatchObject({ login: 'aluno', status: 'OK' });
  });

  it('aguardar → vincularCodigo → gravarNoToken; pendente e código vinculado expiram; o pendente é de uso único', async () => {
    const { cofre, avancar } = montar();
    const kWeb = await conectar(cofre);
    const dk = (await cofre.chaveDeDados(web, kWeb))!;
    expect(cofre.temPendente('txn1')).toBe(false);
    cofre.aguardar('txn1', { login: 'aluno', dk });
    expect(cofre.temPendente('txn1')).toBe(true);
    avancar(16 * 60_000);
    expect(cofre.temPendente('txn1')).toBe(false);

    cofre.aguardar('txn2', { login: 'aluno', dk });
    cofre.vincularCodigo('txn2', 'h2');
    avancar(6 * 60_000);
    await expect(cofre.gravarNoToken('h2', quem)).resolves.toBeNull();

    cofre.aguardar('txn3', { login: 'aluno', dk });
    cofre.vincularCodigo('txn3', 'h3');
    await expect(cofre.gravarNoToken('h3', quem)).resolves.toHaveLength(32);
    await expect(cofre.gravarNoToken('h3', quem)).resolves.toBeNull();
  });

  it('AAD: o cifrado está amarrado ao dono e ao cliente (linha copiada para outro cliente ou outro usuário não abre)', async () => {
    const { cofre, repo, cofres } = montar();
    const k = await conectar(cofre);
    // A mesma linha (DK cifrada com a K certa) registrada sob outro clientId não abre.
    const copia = repo.rows.get('u1|ufba-web')!;
    await repo.upsert({ userId: 'u1', clientId: 'outro-cliente', login: 'aluno', secret: copia.secret });
    await expect(cofre.abrir({ userId: 'u1', clientId: 'outro-cliente' }, k)).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
    // O cofre de u1 copiado para u2 não abre com a DK certa.
    const dk = (await cofre.chaveDeDados(web, k))!;
    await cofres.upsert({ userId: 'u2', login: 'aluno', secret: cofres.rows.get('u1')!.secret });
    await expect(cofre.desbloquear({ userId: 'u2', clientId: 'ufba-web' }, randomBytes(32), dk)).rejects.toBeInstanceOf(
      CredencialSigaaInvalidaError,
    );
  });

  it('podarCopias mantém só as cópias mais novas de um prefixo e não toca nas dos apps', async () => {
    const { cofre, repo } = montar();
    const kWeb = await conectar(cofre);
    const dk = (await cofre.chaveDeDados(web, kWeb))!;
    for (let i = 1; i <= 5; i++) {
      await cofre.desbloquear({ userId: 'u1', clientId: `ufba-web:s${i}` }, randomBytes(32), dk);
      // o relógio da cópia: a mais nova é a de maior índice
      repo.rows.get(`u1|ufba-web:s${i}`)!.createdAt = new Date(2026, 0, i);
    }
    await autorizar(cofre, kWeb); // cópia de um app (clientId c1)
    await cofre.podarCopias('u1', 'ufba-web:', 2);
    const restantes = [...repo.rows.keys()].filter((k) => k.startsWith('u1|ufba-web:')).sort();
    expect(restantes).toEqual(['u1|ufba-web:s4', 'u1|ufba-web:s5']);
    expect(repo.rows.has('u1|c1')).toBe(true);
  });

  it('cópia no formato antigo (a senha, não a DK) não abre: pede senha de novo', async () => {
    const { cofre, repo } = montar();
    const kWeb = await conectar(cofre);
    // Linha antiga: o cifrado é a senha direto, com a K do cliente.
    await repo.upsert({ ...web, login: 'aluno', secret: cifra(kWeb).encrypt(SENHA) });
    await expect(cofre.abrir(web, kWeb)).rejects.toBeInstanceOf(CredencialSigaaInvalidaError);
  });
});
