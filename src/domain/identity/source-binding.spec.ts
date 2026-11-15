import { decideBinding, moodleBelongsTo, moodleSubject, sigaaSubject, siasbSubject } from './source-binding';

describe('sigaaSubject', () => {
  it('CPF com ou sem máscara vira os mesmos 11 dígitos', () => {
    expect(sigaaSubject('123.456.789-09').value).toBe('12345678909');
    expect(sigaaSubject(' 12345678909 ').value).toBe('12345678909');
    expect(sigaaSubject('123 456 789 09').value).toBe('12345678909');
  });

  it('login que não é CPF fica como digitado, em minúsculas e sem espaços nas pontas', () => {
    expect(sigaaSubject('  Fulano.Tal ').value).toBe('fulano.tal');
    expect(sigaaSubject('1234567890').value).toBe('1234567890'); // 10 dígitos: não é CPF
  });
});

describe('moodleSubject', () => {
  it('host em minúsculas + id numérico', () => {
    expect(moodleSubject('AVA.ufba.br', 199126)).toEqual({ source: 'MOODLE', value: 'ava.ufba.br:199126' });
  });
});

describe('moodleBelongsTo', () => {
  it('login institucional com o mesmo usuário do e-mail: é da pessoa', () => {
    expect(moodleBelongsTo({ auth: 'shibboleth', username: 'luiz.a' }, 'Luiz.A@ufba.br', 'ufba.br')).toBe(true);
  });

  it('usuário diferente, outro domínio ou login que não é o institucional: não é', () => {
    expect(moodleBelongsTo({ auth: 'shibboleth', username: 'outra' }, 'luiz.a@ufba.br', 'ufba.br')).toBe(false);
    expect(moodleBelongsTo({ auth: 'shibboleth', username: 'luiz.a' }, 'luiz.a@gmail.com', 'ufba.br')).toBe(false);
    expect(moodleBelongsTo({ auth: 'manual', username: 'luiz.a' }, 'luiz.a@ufba.br', 'ufba.br')).toBe(false);
  });
});

describe('decideBinding', () => {
  it('ninguém ligado: liga', () => {
    expect(decideBinding('u1', 'h1', { mine: null, ownerOfSubject: null })).toBe('bind');
  });

  it('mesma pessoa, mesmo titular: já ligado (reconectar)', () => {
    expect(decideBinding('u1', 'h1', { mine: 'h1', ownerOfSubject: 'u1' })).toBe('already_bound');
  });

  it('esta conta já tem outro titular: mismatch, mesmo que o novo esteja livre', () => {
    expect(decideBinding('u1', 'h2', { mine: 'h1', ownerOfSubject: null })).toBe('mismatch');
  });

  it('titular de outra conta: taken', () => {
    expect(decideBinding('u2', 'h1', { mine: null, ownerOfSubject: 'u1' })).toBe('taken');
  });
});

describe('siasbSubject', () => {
  it('tira espaços e pontuação da matrícula', () => {
    expect(siasbSubject(' 012345678 ')).toEqual({ source: 'SIASB', value: '012345678' });
    expect(siasbSubject('0123.45678').value).toBe('012345678');
  });
});
