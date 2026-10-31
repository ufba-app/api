import { AesSecretCipher } from './aes-secret-cipher';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('AesSecretCipher', () => {
  it('cifra e decifra, com IV diferente a cada vez', () => {
    const c = new AesSecretCipher(KEY);
    const a = c.encrypt('segredo');
    const b = c.encrypt('segredo');
    expect(a.ciphertext).not.toContain('segredo');
    expect(a.iv).not.toBe(b.iv);
    expect(c.decrypt(a)).toBe('segredo');
  });

  it('detecta adulteração', () => {
    const c = new AesSecretCipher(KEY);
    const s = c.encrypt('segredo');
    expect(() => c.decrypt({ ...s, authTag: Buffer.alloc(16).toString('base64') })).toThrow();
  });

  it('exige chave de 32 bytes', () => {
    expect(() => new AesSecretCipher(undefined)).toThrow(/SECRETS_KEY/);
    expect(() => new AesSecretCipher('abc')).toThrow();
  });
});
