import { DriveRefs } from './drive-refs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('DriveRefs: o ref prova que o link saiu do curso desta pessoa', () => {
  const refs = new DriveRefs(KEY);

  it('assina e verifica; o ref não carrega a URL', () => {
    const ref = refs.sign('u1', { kind: 'doc', id: ID });
    expect(ref.startsWith('gdrive1.doc.')).toBe(true);
    expect(ref).not.toContain('http');
    expect(refs.owns(ref)).toBe(true);
    expect(refs.verify('u1', ref)).toEqual({ kind: 'doc', id: ID });
  });

  it('é preso à pessoa: o ref de outra pessoa não vale', () => {
    expect(refs.verify('u2', refs.sign('u1', { kind: 'file', id: ID }))).toBeNull();
  });

  it('adulteração (id, tipo, assinatura) e ref fabricado pelo agente não valem', () => {
    const ref = refs.sign('u1', { kind: 'file', id: ID });
    const [, kind, id, sig] = ref.split('.');
    const outroId = '2BbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(refs.verify('u1', `gdrive1.${kind}.${outroId}.${sig}`)).toBeNull();
    expect(refs.verify('u1', `gdrive1.doc.${id}.${sig}`)).toBeNull();
    expect(refs.verify('u1', `gdrive1.${kind}.${id}.${'x'.repeat(sig.length)}`)).toBeNull();
    expect(refs.verify('u1', `gdrive1.${kind}.${id}.`)).toBeNull();
    expect(refs.verify('u1', `gdrive1.file.${ID}`)).toBeNull();
    expect(refs.verify('u1', `https://drive.google.com/file/d/${ID}/view`)).toBeNull();
    expect(refs.verify('u1', '')).toBeNull();
    expect(refs.owns('https://ava.test/x')).toBe(false);
  });

  it('chave diferente (outra SECRETS_KEY) não valida', () => {
    const other = new DriveRefs(Buffer.alloc(32, 9).toString('base64'));
    expect(other.verify('u1', refs.sign('u1', { kind: 'file', id: ID }))).toBeNull();
  });
});
