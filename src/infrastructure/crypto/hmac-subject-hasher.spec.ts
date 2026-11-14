import { moodleSubject, sigaaSubject } from '../../domain/identity/source-binding';
import { HmacSubjectHasher } from './hmac-subject-hasher';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

describe('HmacSubjectHasher', () => {
  it('estável, sem o CPF em claro, e diferente por fonte e por chave', () => {
    const h = new HmacSubjectHasher(KEY_A);
    const cpf = sigaaSubject('123.456.789-09');
    expect(h.hash(cpf)).toBe(new HmacSubjectHasher(KEY_A).hash(sigaaSubject('12345678909')));
    expect(h.hash(cpf)).not.toContain('12345678909');
    expect(h.hash(cpf)).not.toBe(new HmacSubjectHasher(KEY_B).hash(cpf));
    expect(h.hash({ source: 'MOODLE', value: cpf.value })).not.toBe(h.hash(cpf));
    expect(h.hash(moodleSubject('ava.ufba.br', 7))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sem SECRETS_KEY só falha ao usar (o boot não quebra)', () => {
    const h = new HmacSubjectHasher(undefined);
    expect(() => h.hash(sigaaSubject('1'))).toThrow('SECRETS_KEY');
  });
});
