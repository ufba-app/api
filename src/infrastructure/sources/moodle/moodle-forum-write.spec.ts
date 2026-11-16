import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { MoodleLive, textoParaHtml } from './moodle-live';

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

describe('MoodleLive.postarForum', () => {
  it('nova discussão: 1 chamada a mod_forum_add_discussion, com forumid, título e mensagem em HTML', async () => {
    const { live, calls } = moodle({ mod_forum_add_discussion: { discussionid: 42, warnings: [] } });
    const r = await live.postarForum!(ctx, { forumId: '77', titulo: 'Dúvida', mensagem: 'Oi\nTudo bem?' });
    expect(calls).toHaveLength(1);
    expect(calls[0].get('wsfunction')).toBe('mod_forum_add_discussion');
    expect(calls[0].get('forumid')).toBe('77');
    expect(calls[0].get('subject')).toBe('Dúvida');
    expect(calls[0].get('message')).toBe('<p>Oi</p><p>Tudo bem?</p>');
    expect(calls[0].get('wstoken')).toBe('SEGREDO123');
    expect(r).toEqual({ discussaoId: '42' });
  });

  it('resposta: 1 chamada a mod_forum_add_discussion_post, com postid e não com forumid', async () => {
    const { live, calls } = moodle({ mod_forum_add_discussion_post: { postid: 99, warnings: [] } });
    const r = await live.postarForum!(ctx, { postId: '55', titulo: 'Re: Prova', mensagem: 'Valeu' });
    expect(calls).toHaveLength(1);
    expect(calls[0].get('wsfunction')).toBe('mod_forum_add_discussion_post');
    expect(calls[0].get('postid')).toBe('55');
    expect(calls[0].has('forumid')).toBe(false);
    expect(r).toEqual({ postId: '99' });
  });

  it('id que não é inteiro não chega ao Moodle', async () => {
    const { live, calls } = moodle({});
    await expect(live.postarForum!(ctx, { forumId: '1;2', titulo: 't', mensagem: 'm' })).rejects.toBeInstanceOf(SourceError);
    await expect(live.postarForum!(ctx, { postId: 'abc', titulo: 't', mensagem: 'm' })).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
  });

  it('erro do Moodle (ex.: sem permissão no fórum) vira SourceError sem o token', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ exception: 'x', errorcode: 'nopostpermission', message: 'Sem permissão, token SEGREDO123' }), { status: 200 })) as unknown as typeof fetch;
    const live = new MoodleLive(fetchFn);
    const err = (await live.postarForum!(ctx, { forumId: '77', titulo: 't', mensagem: 'm' }).catch((e) => e)) as SourceError;
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).not.toContain('SEGREDO123');
  });

  it('verForum devolve o postId (para responder) além do id da discussão', async () => {
    const { live } = moodle({
      mod_forum_get_forum_discussions: { discussions: [{ id: 7, discussion: 9, name: 'Prova', message: '<p>x</p>', attachments: [] }] },
    });
    const [d] = await live.verForum(ctx, '77');
    expect(d).toMatchObject({ id: '9', postId: '7' });
  });
});

describe('textoParaHtml', () => {
  it('escapa HTML e ignora linhas vazias', () => {
    expect(textoParaHtml('<script>x</script>\n\n  \n a & "b"')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p><p> a &amp; &quot;b&quot;</p>');
  });
});
