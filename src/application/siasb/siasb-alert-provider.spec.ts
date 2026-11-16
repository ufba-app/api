import { Logger } from '@nestjs/common';
import { SiasbAlertProvider } from './siasb-alert-provider';

describe('SiasbAlertProvider', () => {
  const copy = (ids: string[]) => ({ connectedUsers: jest.fn(async () => ids) });

  it('tem a chave siasb', () => {
    expect(new SiasbAlertProvider(copy([]), { evaluateUser: jest.fn() }).key).toBe('siasb');
  });

  it('usersToEvaluate devolve o que connectedUsers devolve', async () => {
    const c = copy(['u1', 'u2']);
    const p = new SiasbAlertProvider(c, { evaluateUser: jest.fn() });
    expect(await p.usersToEvaluate()).toEqual(['u1', 'u2']);
    expect(c.connectedUsers).toHaveBeenCalledTimes(1);
  });

  it('evaluateUser delega com o mesmo now e devolve o resultado', async () => {
    const result = { sent: 1, suppressed: 2, skipped: 3, failed: 0 };
    const evaluateUser = jest.fn(async (_id: string, _now: Date) => result);
    const p = new SiasbAlertProvider(copy([]), { evaluateUser });
    const now = new Date('2026-11-15T12:00:00Z');
    expect(await p.evaluateUser('u1', now)).toBe(result);
    expect(evaluateUser).toHaveBeenCalledWith('u1', now);
    expect(evaluateUser.mock.calls[0][1]).toBe(now);
  });

  it('exceção vira failed: 1, sem lançar e sem registrar a mensagem', async () => {
    const secret = 'MENSAGEM-SECRETA-123';
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const con = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const p = new SiasbAlertProvider(copy([]), {
        evaluateUser: jest.fn(async () => {
          throw new Error(secret);
        }),
      });
      await expect(p.evaluateUser('u1', new Date())).resolves.toEqual({ sent: 0, suppressed: 0, skipped: 0, failed: 1 });
      const all = [out, err, log, warn, con].flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)));
      expect(all.join('')).not.toContain(secret);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
