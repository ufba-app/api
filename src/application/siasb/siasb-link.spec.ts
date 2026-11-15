import { inspect } from 'node:util';
import { LinkError } from '../oauth/oauth-ports';
import {
  SourceAccountRepository,
  SourceBindingRepository,
  StudentRegistrations,
  SubjectHasher,
  type EncryptedSecret,
  type SourceAccountRecord,
  type UpsertSourceAccountInput,
} from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import { SiasbError, SiasbSession, SiasbSource, type SiasbCourse } from '../ports/siasb-source';
import { SourceBindings } from '../identity/source-bindings';
import { Secret } from '../shared/secret';
import { SiasbLink } from './siasb-link';

const SENHA = 'senha-canario-123';
const REG = '012345678';

class FakeSiasb extends SiasbSource {
  courseCalls = 0;
  loginCalls: { registration: string; courseId: number }[] = [];
  courses: SiasbCourse[] = [
    { id: 1, name: 'Odontologia', abbreviation: 'ODO', isDefault: false },
    { id: 2, name: 'Medicina', abbreviation: 'MED', isDefault: true },
  ];
  username = REG;
  failure: SiasbError | null = null;
  expiresAt: Date | null = new Date('2026-12-01T00:00:00Z');
  courseRegistrations: string[] = [];
  async courseOptions(registration: string) {
    this.courseRegistrations.push(registration);
    this.courseCalls++;
    if (this.failure) throw this.failure;
    return this.courses;
  }
  async login(registration: string, _password: Secret, courseId: number) {
    this.loginCalls.push({ registration, courseId });
    if (this.failure) throw this.failure;
    return { session: new SiasbSession({ k: 'v' }, this.expiresAt), username: this.username };
  }
  disciplines = async () => [];
  attendances = async () => [];
  sessions = async () => [];
  procedures = async () => [];
  unassignedCount = async () => ({});
}

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [];
  upserts: UpsertSourceAccountInput[] = [];
  async upsert(i: UpsertSourceAccountInput) {
    this.upserts.push(i);
    this.rows = this.rows.filter((r) => !(r.userId === i.userId && r.provider === i.provider && r.accountKey === i.accountKey));
    const rec: SourceAccountRecord = {
      id: `a${this.upserts.length}`,
      userId: i.userId,
      provider: i.provider,
      accountKey: i.accountKey,
      siteUrl: i.siteUrl ?? null,
      status: 'OK',
      lastSyncedAt: null,
      expiresAt: i.expiresAt ?? null,
      secret: i.secret ?? null,
    };
    this.rows.push(rec);
    return rec;
  }
  async findByUserAndProvider(userId: string, provider: string) {
    return this.rows.filter((r) => r.userId === userId && r.provider === provider);
  }
  async listByUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
  async setStatus() {}
  async updateSecret() {}
  async delete(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

class FakeBindingRepo extends SourceBindingRepository {
  mine = new Map<string, string>();
  async findMine(userId: string, source: string) {
    return this.mine.get(`${userId}:${source}`) ?? null;
  }
  async findOwner() {
    return null;
  }
  async create(userId: string, source: string, h: string) {
    this.mine.set(`${userId}:${source}`, h);
    return true;
  }
}

class FakeHasher extends SubjectHasher {
  hash(s: { source: string; value: string }) {
    return `h:${s.source}:${s.value}`;
  }
}

class FakeCipher extends SecretCipher {
  seen: string[] = [];
  encrypt(plain: string): EncryptedSecret {
    this.seen.push(plain);
    return { ciphertext: `enc(${plain.length})`, iv: 'iv', authTag: 'tag' };
  }
  decrypt(): string {
    return '';
  }
}

class FakeRegs extends StudentRegistrations {
  constructor(public value: string | null) {
    super();
  }
  async find() {
    return this.value;
  }
}

function setup(registration: string | null = REG) {
  const siasb = new FakeSiasb();
  const accounts = new FakeAccounts();
  const bindingRepo = new FakeBindingRepo();
  const cipher = new FakeCipher();
  let t = 1_000_000;
  const regs = new FakeRegs(registration);
  const copy = new InMemorySiasbCopy();
  const link = new SiasbLink(
    siasb,
    regs,
    new SourceBindings(bindingRepo, new FakeHasher()),
    accounts,
    cipher,
    copy,
    () => t,
  );
  return { siasb, accounts, bindingRepo, cipher, link, regs, copy, advance: (ms: number) => (t += ms) };
}

const pwd = () => Secret.of(SENHA);

describe('SiasbLink.offer', () => {
  it('sem matrícula: não oferece e não chama o SIASB', async () => {
    const { link, siasb } = setup(null);
    expect(await link.offer('u1')).toEqual({ offered: false, courses: [] });
    expect(siasb.courseCalls).toBe(0);
  });

  it('matrícula sem dígitos: não oferece', async () => {
    const { link, siasb } = setup('abc');
    expect(await link.offer('u1')).toEqual({ offered: false, courses: [] });
    expect(siasb.courseCalls).toBe(0);
  });

  it('course-options vazio: não oferece', async () => {
    const { link, siasb } = setup();
    siasb.courses = [];
    expect(await link.offer('u1')).toEqual({ offered: false, courses: [] });
  });

  it('com cursos: oferece', async () => {
    const { link } = setup();
    const r = await link.offer('u1');
    expect(r.offered).toBe(true);
    expect(r.courses).toHaveLength(2);
  });

  it('guarda o resultado por 10 minutos por pessoa', async () => {
    const { link, siasb, advance } = setup();
    await link.offer('u1');
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(1);
    advance(9 * 60_000);
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(1);
    advance(2 * 60_000);
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(2);
  });

  it('falha do SIASB não sobe: offered false', async () => {
    const { link, siasb } = setup();
    siasb.failure = new SiasbError('UNAVAILABLE');
    expect(await link.offer('u1')).toEqual({ offered: false, courses: [] });
  });

  it('falha fica 60 s em cache: duas chamadas fazem uma só ao SIASB; depois de 60 s tenta de novo', async () => {
    const { link, siasb, advance } = setup();
    siasb.failure = new SiasbError('UNAVAILABLE');
    await link.offer('u1');
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(1);
    advance(59_000);
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(1);
    advance(2_000);
    await link.offer('u1');
    expect(siasb.courseCalls).toBe(2);
  });

  it('sucesso depois da janela de falha volta a oferecer', async () => {
    const { link, siasb, advance } = setup();
    siasb.failure = new SiasbError('UNAVAILABLE');
    expect((await link.offer('u1')).offered).toBe(false);
    siasb.failure = null;
    advance(61_000);
    expect((await link.offer('u1')).offered).toBe(true);
    expect((await link.offer('u1')).offered).toBe(true);
  });
});

describe('SiasbLink: matrícula ausente, apagada ou fora do padrão', () => {
  it('hasRegistration: false sem matrícula e sem dígitos; true com matrícula, sem chamar o SIASB', async () => {
    for (const [v, expected] of [[null, false], ['', false], ['abc', false], [REG, true]] as const) {
      const { link, siasb } = setup(v);
      expect(await link.hasRegistration('u1')).toBe(expected);
      expect(siasb.courseCalls).toBe(0);
    }
  });

  it('matrícula apagada (DELETE /me/academic) com conta já conectada: status não muda, offer false, login recusado', async () => {
    const { link, siasb, accounts, regs } = setup();
    await link.connect('u1', pwd());
    regs.value = null;
    siasb.courseCalls = 0;
    siasb.loginCalls = [];
    expect(await link.status('u1')).toEqual({
      state: 'connected',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      syncedAt: null,
    });
    expect(await link.offer('u1')).toEqual({ offered: false, courses: [] });
    const err = await link.connect('u1', pwd()).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toMatch(/vida acadêmica/);
    expect(siasb.courseCalls + siasb.loginCalls.length).toBe(0);
    expect(accounts.rows).toHaveLength(1);
  });

  it('matrícula no formato gravado por saveProfile (só dígitos): oferece e conecta', async () => {
    const { link, siasb } = setup('222333444');
    siasb.username = '222333444';
    expect((await link.offer('u1')).offered).toBe(true);
    await link.connect('u1', pwd());
    expect(siasb.loginCalls[0].registration).toBe('222333444');
  });

  it('normaliza espaços, pontos e traço para courseOptions e login', async () => {
    const { link, siasb } = setup(' 2223.334-44 ');
    siasb.username = '222333444';
    expect((await link.offer('u1')).offered).toBe(true);
    expect(siasb.courseRegistrations).toEqual(['222333444']);
    await link.connect('u1', pwd());
    expect(siasb.loginCalls[0].registration).toBe('222333444');
  });
});

describe('SiasbLink.connect', () => {
  it('feliz: curso padrão, vínculo e conta cifrada com expiresAt', async () => {
    const { link, siasb, accounts, bindingRepo, cipher } = setup();
    await link.connect('u1', pwd());
    expect(siasb.loginCalls).toEqual([{ registration: REG, courseId: 2 }]);
    expect(bindingRepo.mine.get('u1:SIASB')).toBe(`h:SIASB:${REG}`);
    expect(accounts.rows).toHaveLength(1);
    const a = accounts.rows[0];
    expect(a.provider).toBe('SIASB');
    expect(a.accountKey).toBe('siasb');
    expect(a.secret).not.toBeNull();
    expect(a.expiresAt).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(JSON.parse(cipher.seen[0])).toEqual({ k: 'v' });
    expect(cipher.seen.join()).not.toContain(SENHA);
  });

  it('reconectar sem expiração nova limpa a antiga (envia null, não undefined)', async () => {
    const { link, siasb, accounts } = setup();
    siasb.expiresAt = null;
    await link.connect('u1', pwd());
    expect(accounts.upserts[0].expiresAt).toBeNull();
  });

  it('sem curso padrão usa o primeiro', async () => {
    const { link, siasb } = setup();
    siasb.courses = siasb.courses.map((c) => ({ ...c, isDefault: false }));
    await link.connect('u1', pwd());
    expect(siasb.loginCalls[0].courseId).toBe(1);
  });

  it('sem matrícula: LinkError sem chamar o SIASB', async () => {
    const { link, siasb, accounts } = setup(null);
    await expect(link.connect('u1', pwd())).rejects.toBeInstanceOf(LinkError);
    expect(siasb.courseCalls + siasb.loginCalls.length).toBe(0);
    expect(accounts.rows).toHaveLength(0);
  });

  it('matrícula sem dígitos: LinkError sem chamar o SIASB nem vincular', async () => {
    const { link, siasb, bindingRepo } = setup('abc');
    await expect(link.connect('u1', pwd())).rejects.toBeInstanceOf(LinkError);
    expect(siasb.courseCalls + siasb.loginCalls.length).toBe(0);
    expect(bindingRepo.mine.size).toBe(0);
  });

  it('conta já ligada a outra matrícula: recusa antes de falar com o SIASB', async () => {
    const { link, siasb, bindingRepo } = setup();
    bindingRepo.mine.set('u1:SIASB', 'h:SIASB:999');
    await expect(link.connect('u1', pwd())).rejects.toMatchObject({ code: 'source_account_mismatch' });
    expect(siasb.courseCalls + siasb.loginCalls.length).toBe(0);
  });

  it('username diferente da matrícula: source_account_mismatch e nada gravado', async () => {
    const { link, siasb, accounts, bindingRepo } = setup();
    siasb.username = '999999999';
    await expect(link.connect('u1', pwd())).rejects.toMatchObject({ code: 'source_account_mismatch' });
    expect(accounts.rows).toHaveLength(0);
    expect(bindingRepo.mine.size).toBe(0);
  });

  it('compara só os dígitos do username', async () => {
    const { link, siasb, accounts } = setup('0123.45678');
    siasb.username = ' 012345678 ';
    await link.connect('u1', pwd());
    expect(accounts.rows).toHaveLength(1);
  });

  it.each([
    ['CREDENTIAL_REJECTED', 'siasb_credentials_rejected', undefined],
    ['PASSWORD_MIGRATION_REQUIRED', 'siasb_password_migration_required', 'Entre uma vez no SIASB para atualizar sua senha e volte aqui.'],
    ['UNAVAILABLE', 'siasb_unavailable', undefined],
  ] as const)('falha %s: nada gravado, uma tentativa só, erro em pt-BR', async (code, linkCode, text) => {
    const { link, siasb, accounts, bindingRepo, cipher } = setup();
    siasb.failure = new SiasbError(code);
    // courseOptions falharia antes do login; o login é o que está sob teste, então libera os cursos.
    siasb.courseOptions = async () => siasb.courses;
    const err = await link.connect('u1', pwd()).catch((e) => e);
    expect(err).toBeInstanceOf(LinkError);
    expect(err.code).toBe(linkCode);
    if (text) expect(err.message).toBe(text);
    expect(accounts.upserts).toHaveLength(0);
    expect(bindingRepo.mine.size).toBe(0);
    expect(siasb.loginCalls).toHaveLength(1);
    const seen = [String(err.message), inspect(err), JSON.stringify(cipher.seen)].join('|');
    expect(seen).not.toContain(SENHA);
  });
});

describe('SiasbLink.status e disconnect', () => {
  it('sem conta: disconnected', async () => {
    const { link } = setup();
    expect(await link.status('u1')).toEqual({ state: 'disconnected', expiresAt: null, syncedAt: null });
  });

  it('syncedAt vem do último sucesso da cópia', async () => {
    const { link, copy } = setup();
    await link.connect('u1', pwd());
    expect((await link.status('u1')).syncedAt).toBeNull();
    copy.accounts.set('u1', 'OK');
    const at = new Date('2026-11-15T10:00:00Z');
    copy.seedState('u1');
    await copy.recordAttempt('u1', { result: 'OK', at, nextRunAt: null });
    expect((await link.status('u1')).syncedAt).toEqual(at);
  });

  it('conta OK: connected com expiresAt; outro status: reconnect_required', async () => {
    const { link, accounts } = setup();
    await link.connect('u1', pwd());
    expect(await link.status('u1')).toEqual({
      state: 'connected',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      syncedAt: null,
    });
    accounts.rows[0].status = 'REAUTH_NEEDED';
    expect((await link.status('u1')).state).toBe('reconnect_required');
  });

  it('disconnect apaga a conta', async () => {
    const { link, accounts } = setup();
    await link.connect('u1', pwd());
    await link.disconnect('u1');
    expect(accounts.rows).toHaveLength(0);
  });

  const enc = { ciphertext: 'c', iv: 'i', authTag: 't' };
  const att = {
    id: 'a1',
    disciplineId: 'd',
    disciplineName: 'Clínica',
    treatmentType: 'PLANNING' as const,
    concluded: false,
    firstName: enc,
  };

  it('disconnect apaga a conta primeiro e só depois a cópia (ordem contra cópia órfã)', async () => {
    const { link, accounts, copy } = setup();
    await link.connect('u1', pwd());
    const calls: string[] = [];
    const del = accounts.delete.bind(accounts);
    accounts.delete = async (id: string) => {
      calls.push('deleteAccount');
      return del(id);
    };
    const delAll = copy.deleteAll.bind(copy);
    copy.deleteAll = async (u: string) => {
      calls.push('copy.deleteAll');
      return delAll(u);
    };
    await link.disconnect('u1');
    expect(calls).toEqual(['deleteAccount', 'copy.deleteAll']);
  });

  it('disconnect apaga a cópia e o estado da pessoa e não toca nos de outra', async () => {
    const { link, accounts, copy } = setup();
    await link.connect('u1', pwd());
    copy.accounts.set('u1', 'OK');
    copy.accounts.set('u2', 'OK');
    const at = new Date('2026-11-15T10:00:00Z');
    for (const u of ['u1', 'u2']) {
      await copy.replaceWindow(u, { from: at, to: at }, { attendances: [att], sessions: [] });
      copy.seedState(u);
      await copy.recordAttempt(u, { result: 'OK', at, nextRunAt: null });
    }
    await link.disconnect('u1');
    expect(accounts.rows).toHaveLength(0);
    expect(await copy.attendances('u1')).toEqual([]);
    expect(await copy.state('u1')).toBeNull();
    expect(await copy.attendances('u2')).toHaveLength(1);
    expect((await copy.state('u2'))?.lastSuccessAt).toEqual(at);
  });

  it('disconnect: se a limpeza da cópia falhar, o erro propaga (a conta já saiu; desconectar de novo é idempotente)', async () => {
    const { link, accounts, copy } = setup();
    await link.connect('u1', pwd());
    copy.deleteAll = async () => {
      throw new Error('falha');
    };
    await expect(link.disconnect('u1')).rejects.toThrow('falha');
    expect(accounts.rows).toHaveLength(0);
    await expect(link.disconnect('u1')).rejects.toThrow('falha');
  });
});
