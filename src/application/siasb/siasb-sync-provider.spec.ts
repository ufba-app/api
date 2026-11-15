import { SiasbSyncProvider } from './siasb-sync-provider';

describe('SiasbSyncProvider', () => {
  it('expõe as constantes do SIASB', () => {
    const p = new SiasbSyncProvider({ syncUser: jest.fn() }, { dueUsers: jest.fn() });
    expect(p.key).toBe('siasb');
    expect(p.maxUsersPerRun).toBe(200);
    expect(p.spacingMs).toBe(1500);
    expect(p.maxConsecutiveUnavailable).toBe(3);
  });

  it('delega dueUsers e syncUser', async () => {
    const dueUsers = jest.fn(async () => ['u1']);
    const syncUser = jest.fn(async () => 'BUSY' as const);
    const p = new SiasbSyncProvider({ syncUser }, { dueUsers });
    const now = new Date();
    expect(await p.dueUsers(now, 5)).toEqual(['u1']);
    expect(dueUsers).toHaveBeenCalledWith(now, 5);
    expect(await p.syncUser('u1')).toBe('BUSY');
    expect(syncUser).toHaveBeenCalledWith('u1');
  });
});
