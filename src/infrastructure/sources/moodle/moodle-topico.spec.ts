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

describe('MoodleLive.verTopico', () => {
  it('1 chamada a mod_forum_get_discussion_posts, em ordem cronológica, com respostas ligadas à mensagem de origem', async () => {
    const { live, calls } = moodle({
      mod_forum_get_discussion_posts: {
        posts: [
          { id: 7, parent: 0, userfullname: 'Prof. X', created: 1700000000, message: '<p>Apresentações</p>', attachments: [] },
          { id: 8, parent: 7, userfullname: 'Ana', created: 1700000100, message: '<p>Grupo 3<br>dia 23</p>', attachments: [] },
          { id: 9, parent: 8, userfullname: 'Bia', created: 1700000200, message: '<p>Eu também</p>', attachments: [] },
        ],
      },
    });
    const m = await live.verTopico!(ctx, '612607');
    expect(calls).toHaveLength(1);
    expect(calls[0].get('wsfunction')).toBe('mod_forum_get_discussion_posts');
    expect(calls[0].get('discussionid')).toBe('612607');
    expect(calls[0].get('sortby')).toBe('created');
    expect(calls[0].get('sortdirection')).toBe('ASC');
    expect(m).toEqual([
      expect.objectContaining({ postId: '7', autor: 'Prof. X', mensagem: 'Apresentações' }),
      expect.objectContaining({ postId: '8', respostaA: '7', autor: 'Ana', mensagem: 'Grupo 3\ndia 23' }),
      expect.objectContaining({ postId: '9', respostaA: '8', autor: 'Bia', mensagem: 'Eu também' }),
    ]);
    expect(m[0].respostaA).toBeUndefined();
  });

  it('formato real do Moodle: parentid e author.fullname ligam a resposta e trazem o autor', async () => {
    const { live } = moodle({
      mod_forum_get_discussion_posts: {
        posts: [
          { id: 1555942, parentid: 0, author: { id: 5, fullname: 'Prof. X' }, created: 1700000000, message: '<p>Apresentações</p>', attachments: [] },
          { id: 1556743, parentid: 1555942, author: { id: 6, fullname: 'Adalberto' }, created: 1700000100, message: '<p>Eu e Maria</p>', attachments: [] },
        ],
      },
    });
    const m = await live.verTopico!(ctx, '612607');
    expect(m[0]).toMatchObject({ postId: '1555942', autor: 'Prof. X' });
    expect(m[0].respostaA).toBeUndefined();
    expect(m[1]).toMatchObject({ postId: '1556743', respostaA: '1555942', autor: 'Adalberto', mensagem: 'Eu e Maria' });
  });

  it('o token não vaza e um id que não é inteiro não chega ao Moodle', async () => {
    const { live, calls } = moodle({});
    await expect(live.verTopico!(ctx, '1;2')).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
  });

  it('erro do Moodle vira SourceError sem o token', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ exception: 'x', errorcode: 'accessexception', message: 'sem acesso, token SEGREDO123' }), { status: 200 })) as unknown as typeof fetch;
    const err = (await new MoodleLive(fetchFn).verTopico!(ctx, '612607').catch((e) => e)) as SourceError;
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).not.toContain('SEGREDO123');
  });
});
