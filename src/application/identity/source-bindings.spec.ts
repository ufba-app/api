import { sigaaSubject } from '../../domain/identity/source-binding';
import { LinkError } from '../oauth/oauth-ports';
import type { SourceBindingRepository, SubjectHasher } from '../ports/repositories';
import { SourceBindings } from './source-bindings';

const hasher: SubjectHasher = { hash: (s) => `h:${s.source}:${s.value}` };
const CPF = sigaaSubject('123.456.789-09');

function repo(rows: { userId: string; hash: string }[] = []) {
  const r: SourceBindingRepository & { rows: typeof rows } = {
    rows,
    findMine: async (u) => rows.find((x) => x.userId === u)?.hash ?? null,
    findOwner: async (_s, h) => rows.find((x) => x.hash === h)?.userId ?? null,
    create: async (u, _s, h) => {
      if (rows.some((x) => x.userId === u || x.hash === h)) return false;
      rows.push({ userId: u, hash: h });
      return true;
    },
  };
  return r;
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: LinkError) => e.code);

describe('SourceBindings', () => {
  it('liga, reconecta e recusa outro titular ou titular de outra conta', async () => {
    const r = repo();
    const b = new SourceBindings(r, hasher);
    expect(await code(b.bind('u1', CPF))).toBe('ok');
    expect(await code(b.bind('u1', sigaaSubject('12345678909')))).toBe('ok');
    expect(await code(b.bind('u1', sigaaSubject('98765432100')))).toBe('source_account_mismatch');
    expect(await code(b.bind('u2', CPF))).toBe('source_account_taken');
    expect(r.rows).toHaveLength(1);
  });

  it('assertCompatible só olha o vínculo da própria conta (não revela titular de outra)', async () => {
    const b = new SourceBindings(repo([{ userId: 'u1', hash: hasher.hash(CPF) }]), hasher);
    expect(await code(b.assertCompatible('u2', CPF))).toBe('ok');
    expect(await code(b.assertCompatible('u1', CPF))).toBe('ok');
    expect(await code(b.assertCompatible('u1', sigaaSubject('98765432100')))).toBe('source_account_mismatch');
  });

  it('corrida: outro vínculo nasce entre a leitura e a escrita; a releitura decide', async () => {
    const r = repo();
    const original = r.create;
    // Antes de gravar, "outra requisição" liga o mesmo CPF a outra conta.
    r.create = async (u, s, h) => {
      r.rows.push({ userId: 'u-rapida', hash: h });
      r.create = original;
      return original(u, s, h);
    };
    expect(await code(new SourceBindings(r, hasher).bind('u1', CPF))).toBe('source_account_taken');
  });
});
