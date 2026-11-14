import { Secret } from '../../../application/shared/secret';
import { createHash } from 'node:crypto';
import { MoodleLink, MoodleLinkError } from './moodle-link';

const SITE = 'https://ava.ufba.br';
const WSTOKEN = 'wstoken-secreto-123';

function build(
  site: Record<string, unknown> = { username: 'luiz.a', userid: 7 },
  users: unknown = [{ id: 7, auth: 'shibboleth' }],
) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const fn = new URLSearchParams(String(init.body)).get('wsfunction')!;
    calls.push(fn);
    return new Response(JSON.stringify(fn === 'core_webservice_get_site_info' ? site : users), { status: 200 });
  }) as unknown as typeof fetch;
  const link = new MoodleLink({ siteUrl: SITE, passportKey: 'chave-de-teste', fetchFn });
  return { link, calls };
}

/** Simula o que o Moodle devolve: base64(<md5(site+passport)>:::<wstoken>:::<privatetoken>). */
async function moodleReturn(link: MoodleLink, userId: string, txn: string, sigPassport?: string) {
  const passport = new URL(await link.launchUrl(userId, txn)).searchParams.get('passport')!;
  const sig = createHash('md5').update(SITE + (sigPassport ?? passport)).digest('hex');
  return `web+ufba://token=${Buffer.from(`${sig}:::${WSTOKEN}:::PRIVADO`).toString('base64')}`;
}

describe('MoodleLink', () => {
  it('monta o launch.php com passport próprio da transação e urlscheme web+ufba', async () => {
    const { link } = build();
    const u = new URL(await link.launchUrl('u1', 'txn1'));
    expect(u.origin + u.pathname).toBe(`${SITE}/admin/tool/mobile/launch.php`);
    expect(u.searchParams.get('service')).toBe('moodle_mobile_app');
    expect(u.searchParams.get('urlscheme')).toBe('web+ufba');
    expect(link.scheme()).toBe('web+ufba');
    const p1 = u.searchParams.get('passport');
    expect(p1).toMatch(/^[0-9a-f]{24}$/);
    expect(new URL(await link.launchUrl('u1', 'txn1')).searchParams.get('passport')).toBe(p1); // estável
    expect(new URL(await link.launchUrl('u1', 'txn2')).searchParams.get('passport')).not.toBe(p1);
    expect(new URL(await link.launchUrl('u2', 'txn1')).searchParams.get('passport')).not.toBe(p1);
  });

  it('verifica o link: devolve usuário, id e método de login, só o wstoken (sem o privatetoken), e não grava nada', async () => {
    const { link, calls } = build();
    const acc = await link.verify('u1', 'txn1', await moodleReturn(link, 'u1', 'txn1'));
    expect(acc).toMatchObject({ siteUrl: SITE, host: 'ava.ufba.br', moodleUserId: 7, username: 'luiz.a', auth: 'shibboleth' });
    expect(acc.token).toBeInstanceOf(Secret);
    expect(acc.token.reveal()).toBe(WSTOKEN);
    expect(calls).toEqual(['core_webservice_get_site_info', 'core_user_get_users_by_field']);
  });

  it('sem o método de login no perfil: erro, nenhuma conta devolvida', async () => {
    const { link } = build(undefined, []);
    await expect(link.verify('u1', 'txn1', await moodleReturn(link, 'u1', 'txn1'))).rejects.toThrow(MoodleLinkError);
  });

  it('aceita o link com espaços/quebra de linha ao redor, o esquema moodlemobile e só o base64', async () => {
    const { link } = build();
    const full = await moodleReturn(link, 'u1', 'txn1');
    for (const text of [`  ${full}\n`, full.replace('web+ufba://', 'moodlemobile://'), full.replace('web+ufba://token=', '')]) {
      await expect(link.verify('u1', 'txn1', text)).resolves.toMatchObject({ username: 'luiz.a' });
    }
  });

  it('recusa link de outro pedido (passport não confere) sem falar com o Moodle', async () => {
    const { link, calls } = build();
    const doOutro = await moodleReturn(link, 'u1', 'txn-outro');
    await expect(link.verify('u1', 'txn1', doOutro)).rejects.toThrow('não é deste pedido');
    await expect(link.verify('u2', 'txn1', await moodleReturn(link, 'u1', 'txn1'))).rejects.toThrow(MoodleLinkError);
    expect(calls).toEqual([]);
  });

  it.each([['lixo qualquer'], [''], ['web+ufba://token=%%%'], ['web+ufba://token=YWJj']])(
    'recusa texto inválido (%j)',
    async (txt) => {
      const { link, calls } = build();
      await expect(link.verify('u1', 'txn1', txt)).rejects.toThrow(MoodleLinkError);
      expect(calls).toEqual([]);
    },
  );

  it('recusa token que o Moodle rejeita, sem vazar o token na mensagem', async () => {
    const { link } = build({ exception: 'x', errorcode: 'invalidtoken', message: `ruim ${WSTOKEN}` });
    const err = await link.verify('u1', 'txn1', await moodleReturn(link, 'u1', 'txn1')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(MoodleLinkError);
    expect(String((err as Error).message)).not.toContain(WSTOKEN);
  });
});
