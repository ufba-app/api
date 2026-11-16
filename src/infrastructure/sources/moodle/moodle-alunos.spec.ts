import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { MoodleLive } from './moodle-live';

const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'ava.test:aluno',
  siteUrl: 'https://ava.test',
  credentials: { kind: 'token', token: Secret.of('SEGREDO123') },
};

function moodle(responses: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    calls.push(body);
    return new Response(JSON.stringify(responses[body.get('wsfunction') as string] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { live: new MoodleLive(fetchFn), calls };
}

describe('MoodleLive.listarParticipantes', () => {
  it('1 chamada a core_enrol_get_enrolled_users e só nome e papéis saem do adaptador', async () => {
    const { live, calls } = moodle({
      core_enrol_get_enrolled_users: [
        { id: 1, fullname: 'Ana Souza', email: 'ana@ufba.br', idnumber: '123', profileimageurl: 'x', roles: [{ roleid: 5, shortname: 'student' }] },
        { id: 2, fullname: 'Prof. X', email: 'x@ufba.br', roles: [{ roleid: 3, shortname: 'editingteacher' }] },
      ],
    });
    const r = await live.listarParticipantes!(ctx, '359934');
    expect(calls).toHaveLength(1);
    expect(calls[0].get('wsfunction')).toBe('core_enrol_get_enrolled_users');
    expect(calls[0].get('courseid')).toBe('359934');
    expect(r).toEqual([
      { nome: 'Ana Souza', papeis: ['student'] },
      { nome: 'Prof. X', papeis: ['editingteacher'] },
    ]);
    expect(JSON.stringify(r)).not.toContain('@ufba.br');
  });

  it('id de curso inválido não chega ao Moodle; erro não vaza o token', async () => {
    const { live, calls } = moodle({});
    await expect(live.listarParticipantes!(ctx, '1;2')).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ exception: 'x', errorcode: 'accessexception', message: 'sem acesso, token SEGREDO123' }), { status: 200 })) as unknown as typeof fetch;
    const err = (await new MoodleLive(fetchFn).listarParticipantes!(ctx, '359934').catch((e) => e)) as SourceError;
    expect(err.message).not.toContain('SEGREDO123');
  });
});
