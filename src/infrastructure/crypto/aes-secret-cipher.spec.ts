import { randomBytes } from 'node:crypto';
import { AesSecretCipher } from './aes-secret-cipher';
import { deriveKey, parseSecretsKey } from './keys';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('AesSecretCipher', () => {
  it('cifra e decifra (inclusive acentos), com IV diferente a cada vez', () => {
    const c = new AesSecretCipher(KEY);
    const a = c.encrypt('1//refresh-token-áé');
    const b = c.encrypt('1//refresh-token-áé');
    expect(a.ciphertext).not.toContain('refresh-token');
    expect(a.iv).not.toBe(b.iv);
    expect(c.decrypt(a)).toBe('1//refresh-token-áé');
  });

  it('detecta adulteração da tag e do cifrado', () => {
    const c = new AesSecretCipher(KEY);
    const s = c.encrypt('segredo');
    expect(() => c.decrypt({ ...s, authTag: Buffer.alloc(16).toString('base64') })).toThrow();
    const bad = Buffer.from(s.ciphertext, 'base64');
    bad[0] ^= 1;
    expect(() => c.decrypt({ ...s, ciphertext: bad.toString('base64') })).toThrow();
  });

  it('falha com outra chave', () => {
    const s = new AesSecretCipher(KEY).encrypt('a');
    expect(() => new AesSecretCipher(randomBytes(32).toString('base64')).decrypt(s)).toThrow();
  });

  it('aceita chave em hex ou base64 e exige 32 bytes', () => {
    const raw = randomBytes(32);
    const s = new AesSecretCipher(raw.toString('hex')).encrypt('ok');
    expect(new AesSecretCipher(raw.toString('base64')).decrypt(s)).toBe('ok');
    expect(() => new AesSecretCipher(undefined)).toThrow(/SECRETS_KEY/);
    expect(() => new AesSecretCipher('abc')).toThrow(/32 bytes/);
  });
});

describe('deriveKey', () => {
  it('gera chaves distintas por finalidade, e nenhuma igual à mestra', () => {
    const a = deriveKey(KEY, 'moodle-passport');
    const b = deriveKey(KEY, 'outra-coisa');
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(parseSecretsKey(KEY))).toBe(false);
    expect(deriveKey(KEY, 'moodle-passport').equals(a)).toBe(true);
  });
});
