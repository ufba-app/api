import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('hex'));

  it('cifra e decifra (ida e volta)', () => {
    const enc = box.encrypt('1//refresh-token-áé');
    expect(enc).not.toContain('refresh-token');
    expect(box.decrypt(enc)).toBe('1//refresh-token-áé');
  });

  it('usa IV aleatório: mesma entrada gera saídas diferentes', () => {
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
  });

  it('detecta adulteração', () => {
    const [v, iv, tag, data] = box.encrypt('segredo').split(':');
    const bad = Buffer.from(data, 'base64');
    bad[0] ^= 1;
    expect(() => box.decrypt([v, iv, tag, bad.toString('base64')].join(':'))).toThrow();
  });

  it('falha com outra chave', () => {
    const other = new SecretBox(randomBytes(32));
    expect(() => other.decrypt(box.encrypt('a'))).toThrow();
  });

  it('rejeita chave de tamanho errado e formato inválido', () => {
    expect(() => new SecretBox('curta')).toThrow(/32 bytes/);
    expect(() => box.decrypt('lixo')).toThrow(/inválido/);
  });

  it('aceita chave base64 e lê do env', () => {
    const b64 = randomBytes(32).toString('base64');
    const fromEnv = SecretBox.fromEnv({ SECRETS_KEY: b64 });
    expect(fromEnv.decrypt(new SecretBox(b64).encrypt('ok'))).toBe('ok');
    expect(() => SecretBox.fromEnv({})).toThrow(/SECRETS_KEY/);
  });
});
